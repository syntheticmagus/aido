export interface ToolResult {
  success: boolean;
  // Always a string — gets embedded verbatim in the LLM's tool_result block.
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  agentId: string;
  taskId: string;
  workspaceRoot: string;
  projectName: string;
  /** Role of the agent — used to enforce file write permissions at the tool layer. */
  taskType?: import('../config/schema.js').TaskType;
  /**
   * For implement agents: the exact file paths (relative to workspaceRoot) this agent
   * is permitted to write. Writes to any other path are blocked. Empty = unrestricted.
   */
  assignedFiles?: string[];
  // Stream output chunks back to the UI / socket layer in real time.
  emitOutput: (chunk: string) => void;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  // JSON Schema for the tool's parameters.
  readonly parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(params: unknown, context: AgentContext): Promise<ToolResult>;
}
