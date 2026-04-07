import { EventEmitter } from 'node:events';
import PQueue from 'p-queue';
import { generateId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import type { BaseAgent, AgentResult } from '../agents/base-agent.js';
import type { Task } from '../config/schema.js';
import type { AgentContext } from '../tools/types.js';

const log = createLogger({ module: 'agent-pool' });

export interface ActiveAgentInfo {
  agentId: string;
  taskId: string;
  role: string;
  modelId: string;
  startTime: number;
}

export type AgentFactory = (
  task: Task,
  context: AgentContext,
) => BaseAgent;

export class AgentPool extends EventEmitter {
  private activeAgents = new Map<string, { agent: BaseAgent; info: ActiveAgentInfo }>();
  private queue: PQueue;

  constructor(concurrency: number) {
    super();
    this.queue = new PQueue({ concurrency });
  }

  async spawn(
    task: Task,
    workspaceRoot: string,
    projectName: string,
    factory: AgentFactory,
  ): Promise<void> {
    const agentId = generateId('agent');
    const info: ActiveAgentInfo = {
      agentId,
      taskId: task.id,
      role: task.type,
      modelId: task.assignedModel ?? 'unknown',
      startTime: Date.now(),
    };

    const context: AgentContext = {
      agentId,
      taskId: task.id,
      workspaceRoot,
      projectName,
      emitOutput: (chunk: string) => {
        this.emit('agent:output', { agentId, taskId: task.id, chunk });
      },
    };

    const agent = factory(task, context);
    this.activeAgents.set(agentId, { agent, info });
    this.emit('agent:spawned', info);

    void this.queue.add(async () => {
      try {
        log.info({ agentId, taskId: task.id, role: task.type }, 'Agent starting');
        const result = await agent.run(task.description);
        this.activeAgents.delete(agentId);
        this.emit('agent:completed', { agentId, taskId: task.id, result });
        log.info({ agentId, success: result.success }, 'Agent completed');
      } catch (err) {
        this.activeAgents.delete(agentId);
        const result: AgentResult = {
          success: false,
          summary: (err as Error).message,
          artifacts: [],
          tokensUsed: { input: 0, output: 0 },
          error: (err as Error).message,
        };
        this.emit('agent:completed', { agentId, taskId: task.id, result });
        log.error({ agentId, err }, 'Agent threw exception');
      }
    });
  }

  terminate(agentId: string, reason: string): void {
    const entry = this.activeAgents.get(agentId);
    if (entry) {
      entry.agent.abort = true;
      this.activeAgents.delete(agentId);
      this.emit('agent:terminated', { agentId, reason });
      log.info({ agentId, reason }, 'Agent terminated');
    }
  }

  getActive(): ActiveAgentInfo[] {
    return [...this.activeAgents.values()].map((e) => e.info);
  }

  async waitForAll(): Promise<void> {
    await this.queue.onIdle();
  }
}
