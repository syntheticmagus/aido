import { create } from 'zustand';
import type {
  Task,
  AgentInfo,
  BudgetState,
  LogEntry,
  ClaudeCodeStatus,
  ProjectStatus,
} from '../types/index.ts';

const MAX_LOGS = 500;

interface AppState {
  // Connection
  connected: boolean;

  // Project
  projectStatus: ProjectStatus;
  projectName: string | null;

  // Task graph
  tasks: Record<string, Task>;

  // Agents
  agents: Record<string, AgentInfo>;
  // Streaming output chunks per agent — stored as arrays, written directly to xterm
  agentOutputs: Record<string, string[]>;

  // Budget
  budget: BudgetState | null;

  // Claude Code
  claudeCodeStatus: ClaudeCodeStatus;
  claudeCodeTaskId: string | null;
  claudeCodeCooldownUntil: string | null;

  // Logs
  logs: LogEntry[];

  // Actions
  setConnected(v: boolean): void;
  upsertTask(task: Task): void;
  upsertAgent(agent: AgentInfo): void;
  appendAgentOutput(agentId: string, chunk: string): void;
  removeAgent(agentId: string): void;
  updateBudget(state: BudgetState): void;
  appendLog(entry: LogEntry): void;
  setProjectStatus(status: ProjectStatus, name?: string): void;
  setClaudeCodeStatus(status: ClaudeCodeStatus, taskId?: string, cooldownUntil?: string): void;
}

export const useAppStore = create<AppState>((set) => ({
  connected: false,
  projectStatus: 'idle',
  projectName: null,
  tasks: {},
  agents: {},
  agentOutputs: {},
  budget: null,
  claudeCodeStatus: 'idle',
  claudeCodeTaskId: null,
  claudeCodeCooldownUntil: null,
  logs: [],

  setConnected: (v) => set({ connected: v }),

  upsertTask: (task) =>
    set((state) => ({
      tasks: { ...state.tasks, [task.id]: task },
    })),

  upsertAgent: (agent) =>
    set((state) => ({
      agents: { ...state.agents, [agent.agentId]: agent },
    })),

  appendAgentOutput: (agentId, chunk) =>
    set((state) => {
      const existing = state.agentOutputs[agentId] ?? [];
      return {
        agentOutputs: {
          ...state.agentOutputs,
          [agentId]: [...existing, chunk],
        },
      };
    }),

  removeAgent: (agentId) =>
    set((state) => {
      const agents = { ...state.agents };
      delete agents[agentId];
      return { agents };
    }),

  updateBudget: (budget) => set({ budget }),

  appendLog: (entry) =>
    set((state) => ({
      logs: [...state.logs.slice(-MAX_LOGS + 1), entry],
    })),

  setProjectStatus: (status, name) =>
    set((state) => ({
      projectStatus: status,
      projectName: name ?? state.projectName,
    })),

  setClaudeCodeStatus: (status, taskId, cooldownUntil) =>
    set({
      claudeCodeStatus: status,
      claudeCodeTaskId: taskId ?? null,
      claudeCodeCooldownUntil: cooldownUntil ?? null,
    }),
}));
