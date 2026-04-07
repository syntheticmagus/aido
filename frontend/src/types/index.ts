// Shared types mirrored from backend src/config/schema.ts

export type TaskType =
  | 'architecture' | 'implement' | 'test' | 'review'
  | 'debug' | 'devops' | 'docs' | 'integrate' | 'validate';

export type TaskStatus =
  | 'pending' | 'blocked' | 'assigned' | 'in-progress'
  | 'review' | 'done' | 'failed';

export interface TaskResult {
  success: boolean;
  summary: string;
  artifacts: string[];
  tokensUsed: { input: number; output: number };
  cost: number;
  durationMs: number;
  error?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  dependencies: string[];
  assignedAgent?: string;
  assignedModel?: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  artifacts: string[];
  result?: TaskResult;
  createdBy: string;
  estimatedTokens?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInfo {
  agentId: string;
  taskId: string;
  role: string;
  modelId: string;
  startTime: number;
}

export interface BudgetState {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  remaining: number;
  percentUsed: number;
  startTime: number;
  elapsedMs: number;
}

export interface LogEntry {
  level: string;
  msg: string;
  time: number;
  [key: string]: unknown;
}

export type ClaudeCodeStatus = 'idle' | 'busy' | 'rate-limited' | 'unavailable';

export type ProjectStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed';
