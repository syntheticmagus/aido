import { BaseAgent } from './base-agent.js';
import { ToolRegistry } from '../tools/registry.js';
import { FileReadTool, FileSearchTool, DirectoryListTool } from '../tools/filesystem.js';
import { GitDiffTool, GitLogTool } from '../tools/git.js';
import { TaskGraph } from '../orchestrator/task-graph.js';
import { BudgetTracker } from '../orchestrator/budget-tracker.js';
import { createLogger } from '../utils/logger.js';
import { timestamp } from '../utils/id.js';
import type { LLMProvider } from '../llm/types.js';
import type { ModelConfig } from '../config/schema.js';
import type { AgentContext, Tool, ToolResult } from '../tools/types.js';
import type { AgentResult } from './base-agent.js';
import type { ClaudeCodeBridge } from '../tools/claude-code.js';
import { formatInboxFile } from '../tools/claude-code.js';

const log = createLogger({ module: 'team-lead' });

/**
 * Function provided by the orchestrator that runs a worker agent on a task.
 * The call is synchronous from the team lead's perspective — it blocks until
 * the agent completes and returns the result for immediate review.
 */
export type RunAgentFn = (task: import('../config/schema.js').Task, instruction?: string) => Promise<AgentResult>;

export class TeamLeadAgent extends BaseAgent {
  private _tools: ToolRegistry;

  constructor(
    model: ModelConfig,
    provider: LLMProvider,
    context: AgentContext,
    private readonly taskGraph: TaskGraph,
    private readonly budgetTracker: BudgetTracker,
    maxToolCalls: number,
    private readonly claudeCodeBridge?: ClaudeCodeBridge,
    private readonly runAgent?: RunAgentFn,
  ) {
    super(model, provider, context, maxToolCalls);
    this._tools = this.buildTools();
  }

  protected get systemPrompt(): string {
    return `You are the Team Lead for an autonomous software development project.
You manage the project by directing worker agents — you never implement anything yourself.

## Strict Workflow — follow this for every task

### Step 1: PLAN
- Call list_tasks to see current project state.
- Call create_task for any missing tasks, with clear descriptions and correct dependencies.
- Tasks must be created in dependency order: architecture → implement → test → review.

### Step 2: DISPATCH
- For each pending task whose dependencies are done, call dispatch_task.
- Provide an "instruction" field with precise guidance: what to build, what patterns to follow,
  what the agent should verify before calling report_result.
- dispatch_task runs the worker agent and returns when it finishes — you will see the result immediately.
- While the agent runs, you are the user: the instruction you provide IS the brief.
  Make it specific enough that the agent does not need to ask clarifying questions.

### Step 3: REVIEW
- dispatch_task returns the agent's result (success/failure + summary).
- Read the relevant output files with file_read to verify the work is correct.
- If acceptable: call approve_result — this marks the task done and unblocks dependents.
- If not acceptable: call reject_result with specific, actionable feedback.
  The task will be re-queued; dispatch it again after.

### Repeat Steps 1–3 until all tasks are done.

## Hard Rules
- NEVER write code, edit files, run shell commands, or implement anything yourself.
- dispatch_task is the ONLY way to execute work. Use it for every task.
- Do not dispatch a task if its dependencies are not yet done (status ≠ done).
- Always approve_result or reject_result after each dispatch_task call — never leave tasks in "review".

## Task Types
architecture | implement | test | review | debug | devops | docs | integrate | validate

## Tool Reference
- list_tasks           — see all tasks and statuses
- create_task          — create a new task with dependencies
- dispatch_task        — run a worker agent on a pending task (blocks until done)
- approve_result       — mark a reviewed task as done
- reject_result        — send a task back for rework with feedback
- update_task          — change priority or status of a task
- query_budget         — check remaining budget
- file_read / directory_list — read workspace files to review agent output
- escalate_to_claude_code — for tasks that have failed 2+ times`;
  }

  protected get tools(): ToolRegistry {
    return this._tools;
  }

  // The Team Lead runs in individual turns (called by orchestrator), not as a one-shot agent.
  async runTurn(message: string): Promise<void> {
    log.info({ message: message.slice(0, 100) }, 'Team Lead turn starting');
    try {
      await this.run(message);
    } catch (err) {
      log.error({ err }, 'Team Lead turn failed');
    }
  }

  protected parseResult(lastTextBlock: string): AgentResult {
    return {
      success: true,
      summary: lastTextBlock.slice(0, 500),
      artifacts: [],
      tokensUsed: { input: 0, output: 0 },
    };
  }

  private buildTools(): ToolRegistry {
    const registry = new ToolRegistry();

    // Read-only tools — team lead reviews but does not implement
    registry.register(new FileReadTool());
    registry.register(new FileSearchTool());
    registry.register(new DirectoryListTool());
    registry.register(new GitDiffTool());
    registry.register(new GitLogTool());

    // Team Lead management tools
    registry.register(this.makeListTasksTool());
    registry.register(this.makeCreateTaskTool());
    registry.register(this.makeDispatchTaskTool());
    registry.register(this.makeUpdateTaskTool());
    registry.register(this.makeCancelTaskTool());
    registry.register(this.makeApproveResultTool());
    registry.register(this.makeRejectResultTool());
    registry.register(this.makeQueryBudgetTool());
    registry.register(this.makeReportResultTool());

    if (this.claudeCodeBridge) {
      registry.register(this.makeEscalateTool(this.claudeCodeBridge));
    }

    return registry;
  }

  private makeListTasksTool(): Tool {
    const graph = this.taskGraph;
    return {
      name: 'list_tasks',
      description: 'List all tasks in the project with their current status, type, and dependencies.',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const tasks = graph.getAllTasks();
        if (tasks.length === 0) return { success: true, output: 'No tasks yet.' };
        const lines = tasks.map((t) => {
          const deps = t.dependencies.length ? ` (deps: ${t.dependencies.join(', ')})` : '';
          const attempts = t.attempts > 0 ? ` [attempt ${t.attempts}/${t.maxAttempts}]` : '';
          return `[${t.id}] ${t.status.toUpperCase().padEnd(11)} | ${t.type.padEnd(12)} | ${t.title}${deps}${attempts}`;
        });
        return { success: true, output: lines.join('\n') };
      },
    };
  }

  private makeDispatchTaskTool(): Tool {
    const graph = this.taskGraph;
    const runAgent = this.runAgent;
    return {
      name: 'dispatch_task',
      description:
        'Run a worker agent on a pending task. Blocks until the agent finishes and returns the result for you to review. ' +
        'After this returns, call approve_result or reject_result.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'ID of the pending task to dispatch' },
          instruction: {
            type: 'string',
            description:
              'Specific guidance for the agent: what to build, patterns to follow, how to verify success. ' +
              'Be precise — the agent cannot ask follow-up questions.',
          },
        },
        required: ['taskId'],
      },
      async execute(params: unknown): Promise<ToolResult> {
        const { taskId, instruction } = params as { taskId: string; instruction?: string };

        const task = graph.getTask(taskId);
        if (!task) return { success: false, output: '', error: `Task ${taskId} not found` };
        if (task.status !== 'pending') {
          return { success: false, output: '', error: `Task ${taskId} cannot be dispatched — status is "${task.status}", must be "pending"` };
        }

        // Verify dependencies are all done
        const blockedBy = task.dependencies.filter((depId) => {
          const dep = graph.getTask(depId);
          return !dep || dep.status !== 'done';
        });
        if (blockedBy.length > 0) {
          return { success: false, output: '', error: `Task ${taskId} is blocked by unfinished dependencies: ${blockedBy.join(', ')}` };
        }

        if (!runAgent) {
          return { success: false, output: '', error: 'Agent runner not configured — cannot dispatch' };
        }

        graph.updateTask(taskId, { status: 'in-progress' });

        const result = await runAgent(task, instruction);

        const freshTask = graph.getTask(taskId)!;
        const newAttempts = freshTask.attempts + 1;

        if (result.success) {
          graph.updateTask(taskId, {
            status: 'review',
            attempts: newAttempts,
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
          const nextStatus = newAttempts >= freshTask.maxAttempts ? 'failed' : 'pending';
          graph.updateTask(taskId, { status: nextStatus, attempts: newAttempts });
        }

        const statusLine = result.success
          ? `SUCCESS — task is now in "review" status. Call approve_result or reject_result.`
          : `FAILED (attempt ${newAttempts}/${freshTask.maxAttempts}) — task reset to "${graph.getTask(taskId)?.status}".`;

        return {
          success: true,
          output: `${statusLine}\n\nAgent summary: ${result.summary}\nArtifacts: ${result.artifacts.join(', ') || 'none'}${result.error ? `\nError: ${result.error}` : ''}`,
        };
      },
    };
  }

  private makeCreateTaskTool(): Tool {
    const graph = this.taskGraph;
    return {
      name: 'create_task',
      description: 'Create a new task in the project task graph.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['architecture','implement','test','review','debug','devops','docs','integrate','validate'] },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete first' },
          priority: { type: 'number', description: '1-10, higher = more urgent (default: 5)' },
          maxAttempts: { type: 'number', description: 'Max retry attempts (default: 3)' },
        },
        required: ['title', 'description', 'type'],
      },
      async execute(params: unknown): Promise<ToolResult> {
        const p = params as { title: string; description: string; type: string; dependencies?: string[]; priority?: number; maxAttempts?: number };
        const task = graph.createTask({
          title: p.title,
          description: p.description,
          type: p.type as any,
          dependencies: p.dependencies ?? [],
          priority: p.priority ?? 5,
          maxAttempts: p.maxAttempts ?? 3,
          artifacts: [],
          createdBy: 'team-lead',
        });
        return { success: true, output: `Created task ${task.id}: ${task.title}` };
      },
    };
  }

  private makeUpdateTaskTool(): Tool {
    const graph = this.taskGraph;
    return {
      name: 'update_task',
      description: 'Update task status or fields.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['pending','blocked','assigned','in-progress','review','done','failed'] },
          priority: { type: 'number' },
        },
        required: ['taskId'],
      },
      async execute(params: unknown): Promise<ToolResult> {
        const p = params as { taskId: string; status?: string; priority?: number };
        const task = graph.getTask(p.taskId);
        if (!task) return { success: false, output: '', error: `Task ${p.taskId} not found` };
        graph.updateTask(p.taskId, { status: p.status as any, priority: p.priority });
        return { success: true, output: `Updated task ${p.taskId}` };
      },
    };
  }

  private makeCancelTaskTool(): Tool {
    const graph = this.taskGraph;
    return {
      name: 'cancel_task',
      description: 'Cancel a task by marking it failed.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      async execute(params: unknown): Promise<ToolResult> {
        const { taskId } = params as { taskId: string };
        graph.updateTask(taskId, { status: 'failed' });
        return { success: true, output: `Cancelled task ${taskId}` };
      },
    };
  }

  private makeApproveResultTool(): Tool {
    const graph = this.taskGraph;
    return {
      name: 'approve_result',
      description: 'Approve a completed task result, marking it done.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          feedback: { type: 'string', description: 'Optional positive feedback' },
        },
        required: ['taskId'],
      },
      async execute(params: unknown): Promise<ToolResult> {
        const { taskId } = params as { taskId: string };
        const task = graph.getTask(taskId);
        if (!task) return { success: false, output: '', error: `Task ${taskId} not found` };
        graph.updateTask(taskId, { status: 'done' });
        return { success: true, output: `Task ${taskId} approved and marked done` };
      },
    };
  }

  private makeRejectResultTool(): Tool {
    const graph = this.taskGraph;
    return {
      name: 'reject_result',
      description: 'Reject a task result and send it back for rework.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          feedback: { type: 'string', description: 'Specific feedback on what needs to change' },
        },
        required: ['taskId', 'feedback'],
      },
      async execute(params: unknown): Promise<ToolResult> {
        const { taskId, feedback } = params as { taskId: string; feedback: string };
        const task = graph.getTask(taskId);
        if (!task) return { success: false, output: '', error: `Task ${taskId} not found` };
        const updatedDesc = task.description + `\n\n## Rework Feedback (${timestamp()})\n${feedback}`;
        graph.updateTask(taskId, { status: 'pending', description: updatedDesc });
        return { success: true, output: `Task ${taskId} rejected and queued for rework` };
      },
    };
  }

  private makeQueryBudgetTool(): Tool {
    const budget = this.budgetTracker;
    return {
      name: 'query_budget',
      description: 'Check the current budget status.',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const state = budget.getState();
        return {
          success: true,
          output: `Budget: $${state.totalCost.toFixed(4)} spent, $${state.remaining.toFixed(4)} remaining (${state.percentUsed.toFixed(1)}% used). Elapsed: ${Math.round(state.elapsedMs / 60000)}m`,
        };
      },
    };
  }

  private makeReportResultTool(): Tool {
    return {
      name: 'report_result',
      description: 'Signal that the Team Lead turn is complete.',
      parameters: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          summary: { type: 'string' },
          artifacts: { type: 'array', items: { type: 'string' } },
        },
        required: ['success', 'summary'],
      },
      async execute(): Promise<ToolResult> {
        return { success: true, output: 'Turn complete.' };
      },
    };
  }

  private makeEscalateTool(bridge: ClaudeCodeBridge): Tool {
    return {
      name: 'escalate_to_claude_code',
      description:
        'Escalate a difficult task to Claude Code CLI for deep codebase reasoning. ' +
        'Use when: a worker has failed 2+ times, complex multi-file refactoring is needed, ' +
        'or a subtle bug requires holistic understanding. Do NOT use for routine tasks.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID being escalated' },
          description: { type: 'string', description: 'What Claude Code should do' },
          context: { type: 'string', description: 'Relevant context, error logs, prior attempts' },
        },
        required: ['taskId', 'description', 'context'],
      },
      execute: async (params: unknown, ctx): Promise<ToolResult> => {
        const { taskId, description, context } = params as {
          taskId: string;
          description: string;
          context: string;
        };
        const inboxContent = formatInboxFile(
          taskId,
          description,
          context,
          bridge['inboxDir'] as string,
          bridge['outboxDir'] as string,
          bridge['signalsDir'] as string,
        );
        try {
          const result = await bridge.sendTask(taskId, inboxContent);
          return {
            success: result.status === 'SUCCESS' || result.status === 'PARTIAL',
            output:
              `Status: ${result.status}\n` +
              `Summary: ${result.summary}\n` +
              `Files Changed: ${result.filesChanged}\n` +
              `Issues: ${result.issues}`,
          };
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message };
        }
      },
    };
  }
}
