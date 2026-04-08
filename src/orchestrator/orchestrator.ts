import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { TaskGraph } from './task-graph.js';
import { BudgetTracker } from './budget-tracker.js';
import { AgentPool } from './agent-pool.js';
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
import type { LLMProvider } from '../llm/types.js';

const log = createLogger({ module: 'orchestrator' });

export type ProjectStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed';

export class Orchestrator extends EventEmitter {
  private taskGraph: TaskGraph | null = null;
  private budgetTracker: BudgetTracker | null = null;
  private agentPool: AgentPool | null = null;
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

    // Agent pool
    this.agentPool = new AgentPool(config.defaults.maxConcurrentAgents);
    this.agentPool.on('agent:spawned', (data) => this.emit('agent:spawned', data));
    this.agentPool.on('agent:output', (data) => this.emit('agent:output', data));
    this.agentPool.on('agent:completed', (data: { agentId: string; taskId: string; result: AgentResult }) => {
      this.handleAgentCompleted(data.agentId, data.taskId, data.result);
    });
    this.agentPool.on('agent:terminated', (data) => this.emit('agent:terminated', data));

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

    // Run orchestrator loop in background
    void this.runLoop(initMessage);
  }

  private async runLoop(initialMessage: string): Promise<void> {
    if (!this.teamLead || !this.taskGraph || !this.budgetTracker || !this.agentPool) return;

    // Give the Team Lead its initial message and run one turn
    await this.teamLead.runTurn(initialMessage);

    while (!this.stopped && !this.budgetTracker.isExhausted()) {
      if (this.paused) {
        await sleep(1000);
        continue;
      }

      // Dispatch ready tasks
      const ready = this.taskGraph.getReadyTasks();
      for (const task of ready) {
        if (this.stopped || this.budgetTracker.isExhausted()) break;
        await this.dispatchTask(task);
      }

      // Check for project completion
      const allTasks = this.taskGraph.getAllTasks();
      if (allTasks.length > 0 && allTasks.every((t) => t.status === 'done' || t.status === 'failed')) {
        log.info('All tasks terminal — project complete');
        await this.finalize();
        return;
      }

      // Wait for next event (agent completion or team lead wake), with 5s fallback.
      // AbortController ensures the once() listener is removed when the timeout fires first,
      // preventing listener accumulation across loop iterations.
      {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5000);
        try {
          await once(this.internalBus, 'event', { signal: ac.signal });
        } catch {
          // AbortError (timeout) — loop again
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

  private async dispatchTask(task: Task): Promise<void> {
    if (!this.taskGraph || !this.modelRouter || !this.agentPool || !this.config) return;

    const role: AgentRole = task.type; // TaskType values are a subset of AgentRole — no cast needed
    let model;
    try {
      model = this.modelRouter.selectModel(role, task.assignedModel);
    } catch (err) {
      log.error({ taskId: task.id, err }, 'No model available for task type');
      return;
    }

    this.taskGraph.updateTask(task.id, {
      status: 'assigned',
      assignedModel: model.id,
    });
    this.emit('task:updated', { id: task.id, status: 'assigned', assignedModel: model.id });

    const provider = this.getProvider(model.id);
    if (!provider) {
      log.error({ modelId: model.id }, 'No provider for model');
      this.taskGraph.updateTask(task.id, { status: 'failed' });
      return;
    }

    await this.agentPool.spawn(
      task,
      this.projectRoot,
      this.projectName,
      (t, ctx) => createWorkerAgent(t, ctx, model, provider, this.config!.defaults.maxToolCallsPerTurn),
    );

    this.taskGraph.updateTask(task.id, { status: 'in-progress' });
    this.emit('task:updated', { id: task.id, status: 'in-progress' });
  }

  private handleAgentCompleted(
    agentId: string,
    taskId: string,
    result: AgentResult,
  ): void {
    if (!this.taskGraph || !this.budgetTracker || !this.config) return;

    const task = this.taskGraph.getTask(taskId);
    if (!task) return;

    const model = this.config.models.find((m) => m.id === task.assignedModel);
    if (model) {
      const budgetUpdate = this.budgetTracker.recordUsage(
        agentId,
        model,
        result.tokensUsed.input,
        result.tokensUsed.output,
      );
      this.emit('budget:update', budgetUpdate);
      if (budgetUpdate.justWarned) {
        log.warn({ cost: budgetUpdate.totalCost }, 'Budget warning threshold reached');
      }
    }

    if (result.success) {
      this.taskGraph.updateTask(taskId, {
        status: 'review',
        artifacts: result.artifacts,
        result: {
          success: true,
          summary: result.summary,
          artifacts: result.artifacts,
          tokensUsed: result.tokensUsed,
          cost: 0,
          durationMs: 0,
        },
      });
    } else {
      const task2 = this.taskGraph.getTask(taskId)!;
      const newAttempts = task2.attempts + 1;
      if (newAttempts >= task2.maxAttempts) {
        this.taskGraph.updateTask(taskId, { status: 'failed', attempts: newAttempts });
      } else {
        this.taskGraph.updateTask(taskId, { status: 'pending', attempts: newAttempts });
      }
    }

    this.emit('task:updated', { id: taskId, status: this.taskGraph.getTask(taskId)?.status });
    this.emit('agent:completed', { agentId, taskId, result });

    // Wake Team Lead to review
    void this.wakeTeamLead(`Agent ${agentId} completed task ${taskId}. Result: ${result.success ? 'SUCCESS' : 'FAILED'}. Summary: ${result.summary}`);

    this.internalBus.emit('event');
  }

  private async wakeTeamLead(message: string): Promise<void> {
    if (!this.teamLead || this.paused || this.stopped) return;
    await this.teamLead.runTurn(message);
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
    return this.agentPool?.getActive() ?? [];
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
