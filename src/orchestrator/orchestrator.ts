import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/id.js';
import { TaskGraph } from './task-graph.js';
import { BudgetTracker } from './budget-tracker.js';
import { ModelRouter } from '../llm/router.js';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { TeamLeadAgent } from '../agents/team-lead.js';
import { createWorkerAgent } from '../agents/worker-factory.js';
import { ClaudeCodeBridge } from '../tools/claude-code.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { GoogleProvider } from '../llm/providers/google.js';
import { LocalProvider } from '../llm/providers/local.js';
import { WorkspaceWatcher } from '../workspace/watcher.js';
import type { ModelsConfig, Task, AgentRole } from '../config/schema.js';
import type { AgentResult } from '../agents/base-agent.js';
import type { RunAgentFn } from '../agents/team-lead.js';
import type { LLMProvider } from '../llm/types.js';
import type { AgentContext } from '../tools/types.js';

const log = createLogger({ module: 'orchestrator' });

export type ProjectStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed';

/** Info about a currently-running worker agent (mirrored to the UI). */
interface ActiveAgentInfo {
  agentId: string;
  taskId: string;
  role: string;
  modelId: string;
  startTime: number;
}

/** Injected into the team lead's message every REMINDER_INTERVAL wakes. */
const TEAM_LEAD_REMINDER = `
[PERIODIC GUIDELINES REMINDER]
You are the Team Lead. Follow this workflow:
  1. PLAN  — Use list_tasks to see current state. Add or reconfigure tasks based on what you now know.
             Do NOT create implement tasks before architecture is done — create them from ARCHITECTURE.md's
             "## Implementation Task Breakdown" after the architecture task is approved.
  2. DISPATCH — Call dispatch_task for each pending task whose dependencies are done.
             Instruct agents to read source files (spec, ARCHITECTURE.md) rather than repeating their content.
             For implement tasks: name the exact file path(s) to create in the instruction.
  3. REVIEW — After dispatch_task returns, call approve_result or reject_result with specific feedback.
             For implement tasks: verify files with file_read at the exact paths you specified.
  4. REPEAT — Continue. Revisit the task graph after every major milestone; split or add tasks as needed.

NEVER implement code, write files, or run shell commands yourself.
All implementation goes through dispatch_task — that is the ONLY way to execute work.
`.trim();

const REMINDER_INTERVAL = 4; // inject reminder every N team-lead wakeups

export class Orchestrator extends EventEmitter {
  private taskGraph: TaskGraph | null = null;
  private budgetTracker: BudgetTracker | null = null;
  private modelRouter: ModelRouter | null = null;
  private teamLead: TeamLeadAgent | null = null;
  private internalBus = new EventEmitter();
  private status: ProjectStatus = 'idle';
  private stopped = false;
  private paused = false;
  private projectName = '';
  private projectRoot = '';
  private config: ModelsConfig | null = null;
  private providers = new Map<string, LLMProvider>();
  private claudeCodeBridge: ClaudeCodeBridge | null = null;
  private workspaceWatcher = new WorkspaceWatcher();
  private activeAgents = new Map<string, ActiveAgentInfo>();
  private teamLeadWakeCount = 0;

  constructor(private readonly workspaceManager: WorkspaceManager) {
    super();
    this.setMaxListeners(50);
  }

  async start(
    projectName: string,
    specContent: string,
    config: ModelsConfig,
  ): Promise<void> {
    if (this.status === 'running') {
      throw new Error('Orchestrator is already running');
    }

    this.projectName = projectName;
    this.config = config;
    this.stopped = false;
    this.paused = false;

    // Init or resume workspace
    if (await this.workspaceManager.projectExists(projectName)) {
      log.info({ projectName }, 'Resuming existing project');
      this.projectRoot = this.workspaceManager.getProjectRoot(projectName);
    } else {
      this.projectRoot = await this.workspaceManager.initProject(
        projectName,
        specContent,
        config,
      );
    }

    // Build providers map
    for (const model of config.models) {
      if (this.providers.has(model.id)) continue;
      switch (model.provider) {
        case 'anthropic':
          this.providers.set(model.id, new AnthropicProvider(model.apiKey ?? '', model.baseUrl));
          break;
        case 'openai':
          this.providers.set(model.id, new OpenAIProvider(model.apiKey ?? '', model.baseUrl));
          break;
        case 'google':
          this.providers.set(model.id, new GoogleProvider(model.apiKey ?? ''));
          break;
        case 'local':
          this.providers.set(model.id, new LocalProvider(model.baseUrl ?? 'http://localhost:11434'));
          break;
      }
    }

    // Task graph
    const graphPath = path.join(this.projectRoot, '.aido', 'task-graph.json');
    this.taskGraph = TaskGraph.fromFile(graphPath);
    this.taskGraph.setPersistPath(graphPath);
    this.taskGraph.resetInterruptedTasks(); // recover from crash
    this.taskGraph.onTaskCreated = (task) => this.emit('task:created', task);
    this.taskGraph.onTaskUpdated = (task) => this.emit('task:updated', task);

    // Budget
    const budgetPath = path.join(this.projectRoot, '.aido', 'budget.json');
    this.budgetTracker = new BudgetTracker(
      config.budget.maxTotalCost,
      config.budget.warnAtCost,
      config.budget.maxWallClockHours
        ? config.budget.maxWallClockHours * 3_600_000
        : undefined,
    );
    this.budgetTracker.setPersistPath(budgetPath);

    // Model router
    this.modelRouter = new ModelRouter(config);

    // Claude Code bridge (optional)
    if (config.claudeCode?.enabled) {
      this.claudeCodeBridge = new ClaudeCodeBridge({
        binaryPath: config.claudeCode.binaryPath,
        usageLimitCooldownMs: config.claudeCode.usageLimitCooldownMinutes * 60_000,
        timeoutMs: config.claudeCode.timeoutMinutes * 60_000,
        workspaceRoot: this.projectRoot,
        projectName,
      });
      this.claudeCodeBridge.on('status', (data) => this.emit('claude-code:status', data));
      try {
        await this.claudeCodeBridge.initialize();
        log.info('Claude Code bridge initialized');
      } catch (err) {
        log.warn({ err }, 'Claude Code bridge initialization failed — continuing without it');
        this.claudeCodeBridge = null;
      }
    }

    // Team Lead
    const teamLeadModel = this.modelRouter.selectModel('team-lead');
    const teamLeadProvider = this.getProvider(teamLeadModel.id);
    this.teamLead = new TeamLeadAgent(
      teamLeadModel,
      teamLeadProvider,
      {
        agentId: 'team-lead',
        taskId: 'orchestrator',
        workspaceRoot: this.projectRoot,
        projectName,
        emitOutput: (chunk) => this.emit('agent:output', { agentId: 'team-lead', chunk }),
      },
      this.taskGraph,
      this.budgetTracker,
      Number.MAX_SAFE_INTEGER, // Team Lead is long-running; no artificial call limit
      this.claudeCodeBridge ?? undefined,
      this.makeAgentRunner(),
    );

    // Start workspace watcher
    this.workspaceWatcher.on('changed', (data) => this.emit('workspace:changed', data));
    this.workspaceWatcher.watch(this.projectRoot);

    this.setStatus('running');

    // Give Team Lead the spec and kick off the loop
    const initMessage =
      `You are managing the following project. Read the spec carefully, ` +
      `create an initial task graph, and begin assigning work.\n\n` +
      `# Project Spec\n\n${specContent}`;

    // Run orchestrator loop in background — errors are caught internally so they
    // never become unhandled rejections that would crash the server.
    this.runLoop(initMessage).catch((err) => {
      log.error({ err }, 'Orchestrator loop crashed unexpectedly');
      this.setStatus('failed');
    });
  }

  private async runLoop(initialMessage: string): Promise<void> {
    if (!this.teamLead || !this.taskGraph || !this.budgetTracker) return;

    // Give the Team Lead its initial message and run one turn.
    // The team lead may call dispatch_task (synchronous) multiple times within this turn.
    await this.teamLead.runTurn(initialMessage);

    while (!this.stopped && !this.budgetTracker.isExhausted()) {
      if (this.paused) {
        await sleep(1000);
        continue;
      }

      const allTasks = this.taskGraph.getAllTasks();

      // All tasks terminal → done
      if (allTasks.length > 0 && allTasks.every((t) => t.status === 'done' || t.status === 'failed')) {
        log.info('All tasks terminal — project complete');
        await this.finalize();
        return;
      }

      // Count actionable work for team lead
      const pendingCount = allTasks.filter((t) => t.status === 'pending').length;
      const reviewCount  = allTasks.filter((t) => t.status === 'review').length;
      const hasWork = allTasks.length === 0 || pendingCount > 0 || reviewCount > 0;

      if (hasWork) {
        const summary = allTasks.length === 0
          ? 'No tasks have been created yet. Create the initial task graph now.'
          : `Status: ${pendingCount} task(s) pending dispatch, ${reviewCount} awaiting review, ${allTasks.filter((t) => t.status === 'done').length} done.`;
        await this.wakeTeamLead(summary);
      } else {
        // Tasks are in-progress inside a dispatch_task call — shouldn't normally reach here,
        // but guard with a short sleep so the loop doesn't spin.
        await sleep(2000);
      }

      // Small yield between turns; internalBus.emit('event') from inject/pause also wakes this.
      {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3000);
        try {
          await once(this.internalBus, 'event', { signal: ac.signal });
        } catch {
          // AbortError (timeout) — continue
        } finally {
          clearTimeout(timer);
        }
      }
    }

    if (this.budgetTracker.isExhausted()) {
      log.warn('Budget exhausted — stopping orchestrator');
      this.setStatus('failed');
    }
  }

  /**
   * Creates the RunAgentFn passed to TeamLeadAgent.
   * When the team lead calls dispatch_task, this function runs a worker agent
   * synchronously and returns the result directly to the team lead's conversation.
   */
  private makeAgentRunner(): RunAgentFn {
    return async (task: Task, instruction?: string): Promise<AgentResult> => {
      if (!this.modelRouter || !this.config || !this.budgetTracker || !this.taskGraph) {
        return { success: false, summary: 'Orchestrator not ready', artifacts: [], tokensUsed: { input: 0, output: 0 } };
      }

      const role: AgentRole = task.type;
      let model;
      try {
        model = this.modelRouter.selectModel(role, task.assignedModel);
      } catch (err) {
        log.error({ taskId: task.id, err }, 'No model for task type');
        return { success: false, summary: `No model for role ${role}`, artifacts: [], tokensUsed: { input: 0, output: 0 } };
      }

      this.taskGraph.updateTask(task.id, { assignedModel: model.id });

      const provider = this.getProvider(model.id);
      const agentId = generateId('agent');

      const agentInfo: ActiveAgentInfo = {
        agentId,
        taskId: task.id,
        role: task.type,
        modelId: model.id,
        startTime: Date.now(),
      };
      this.activeAgents.set(agentId, agentInfo);
      this.emit('agent:spawned', agentInfo);

      const context: AgentContext = {
        agentId,
        taskId: task.id,
        workspaceRoot: this.projectRoot,
        projectName: this.projectName,
        emitOutput: (chunk: string) => this.emit('agent:output', { agentId, chunk }),
      };

      const initialMessage = instruction
        ? `${task.description}\n\n## Team Lead Instructions\n${instruction}`
        : task.description;

      const agent = createWorkerAgent(task, context, model, provider, this.config.defaults.maxToolCallsPerTurn);

      let result: AgentResult;
      try {
        log.info({ agentId, taskId: task.id, role }, 'Worker agent starting');
        result = await agent.run(initialMessage);
        log.info({ agentId, success: result.success }, 'Worker agent completed');
      } catch (err) {
        log.error({ agentId, err }, 'Worker agent threw exception');
        result = {
          success: false,
          summary: (err as Error).message,
          artifacts: [],
          tokensUsed: { input: 0, output: 0 },
          error: (err as Error).message,
        };
      }

      this.activeAgents.delete(agentId);
      this.emit('agent:completed', { agentId, taskId: task.id, result });

      // Record budget usage
      const modelCfg = this.config.models.find((m) => m.id === model.id);
      if (modelCfg) {
        const budgetUpdate = this.budgetTracker.recordUsage(
          agentId,
          modelCfg,
          result.tokensUsed.input,
          result.tokensUsed.output,
        );
        this.emit('budget:update', budgetUpdate);
        if (budgetUpdate.justWarned) {
          log.warn({ cost: budgetUpdate.totalCost }, 'Budget warning threshold reached');
        }
      }

      return result;
    };
  }

  private async wakeTeamLead(message: string): Promise<void> {
    if (!this.teamLead || this.paused || this.stopped) return;
    this.teamLeadWakeCount++;
    const fullMessage = this.teamLeadWakeCount % REMINDER_INTERVAL === 0
      ? `${TEAM_LEAD_REMINDER}\n\n---\n${message}`
      : message;
    await this.teamLead.runTurn(fullMessage);
    this.internalBus.emit('event');
  }

  private async finalize(): Promise<void> {
    if (!this.teamLead) return;
    await this.teamLead.runTurn(
      'All tasks are complete. Please generate a final project summary, ' +
      'listing what was built, the file structure, and any known issues.',
    );
    this.setStatus('done');
  }

  pause(): void {
    this.paused = true;
    log.info('Orchestrator paused');
  }

  resume(): void {
    this.paused = false;
    this.internalBus.emit('event');
    log.info('Orchestrator resumed');
  }

  stop(): void {
    this.stopped = true;
    this.internalBus.emit('event');
  }

  overrideTask(taskId: string, action: string): void {
    const task = this.taskGraph?.getTask(taskId);
    if (!task) return;
    if (action === 'retry') {
      this.taskGraph?.updateTask(taskId, { status: 'pending' });
      this.internalBus.emit('event');
    } else if (action === 'cancel') {
      this.taskGraph?.updateTask(taskId, { status: 'failed' });
    }
  }

  injectTeamLeadMessage(message: string): void {
    void this.wakeTeamLead(`[Human override] ${message}`);
  }

  getStatus() {
    return {
      status: this.status,
      projectName: this.projectName,
      budget: this.budgetTracker?.getState(),
    };
  }

  getTasks() {
    return this.taskGraph?.toJSON() ?? { tasks: [] };
  }

  getActiveAgents() {
    return [...this.activeAgents.values()];
  }

  getBudget() {
    return this.budgetTracker?.getState() ?? null;
  }

  private getProvider(modelId: string): LLMProvider {
    const provider = this.providers.get(modelId);
    if (!provider) throw new Error(`No provider for model ${modelId}`);
    return provider;
  }

  private setStatus(status: ProjectStatus): void {
    this.status = status;
    this.emit('project:status', { status });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
