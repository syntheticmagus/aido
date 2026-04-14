// Canonical LLM types — Anthropic-style naming used throughout AIDO.
// Provider implementations translate to/from their native formats.

export type MessageRole = 'user' | 'assistant' | 'system';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens: number;
  systemPrompt?: string;
}

export interface ChatResponse {
  content: ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface ChatChunk {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_end' | 'message_stop' | 'usage';
  // text_delta
  delta?: string;
  // tool_use_start
  toolId?: string;
  toolName?: string;
  // tool_use_delta
  toolIndex?: number;
  inputDelta?: string;
  // tool_use_end
  toolInput?: Record<string, unknown>;
  // usage
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncGenerator<ChatChunk>;
}
