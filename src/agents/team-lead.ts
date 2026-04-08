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
  ) {
    super(model, provider, context, maxToolCalls);
    this._tools = this.buildTools();
  }

  protected get systemPrompt(): string {
    return `You are the Team Lead for an autonomous software development project.
Your job is to manage the project by creating tasks and reviewing results — NOT to implement anything yourself.

## Core Rule: NEVER implement work directly
You MUST NOT write code, run builds, run tests, edit files, or execute shell commands to implement features.
ALL implementation work must be delegated to worker agents via create_task.
If you find yourself tempted to write a file or run npm/git/python yourself, stop and create a task instead.
The only exception: using file_read or directory_list to read the spec or review a worker's output.

## Your responsibilities
1. Read the project spec and break it into concrete tasks with clear dependencies.
2. Dispatch tasks to workers — create_task spawns a fresh focused agent for each piece of work.
3. Review completed work (status: review) — read the relevant files, then approve_result or reject_result.
4. Reject with specific actionable feedback so the reworked task succeeds next time.
5. Escalate to Claude Code when a worker has failed 2+ times on the same task.
6. Maintain architectural consistency — reject work that contradicts prior decisions.

## Task Types
- architecture: System design and tech stack decisions
- implement: Write code for a specific component or feature
- test: Write and run tests for a specific component
- review: Code review of a specific component
- debug: Diagnose and fix a specific failure
- devops: Build scripts, Docker, CI/CD configuration
- docs: Documentation
- integrate: Wire components together
- validate: End-to-end validation

## Dependency ordering
An implement task should depend on its architecture task.
A test task should depend on its implement task.
A review task should depend on what it reviews.
Integration tasks should depend on all components they integrate.

## Tool usage
- create_task: Delegate work to a worker agent. Use this for ALL implementation.
- approve_result / reject_result: Review tasks in "review" status.
- update_task: Change priority or unblock a task.
- query_budget: Check remaining budget before spawning expensive work.
- file_read / directory_list: Read the spec or review worker output (read-only).
- escalate_to_claude_code: For tasks that have failed 2+ times.

Be decisive. Keep the project moving by creating tasks and reviewing results promptly.`;
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
    registry.register(this.makeCreateTaskTool());
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
