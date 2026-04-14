import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.js';
import { RateLimitError } from '../../utils/retry.js';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  Message,
} from '../types.js';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        system: request.systemPrompt,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        })),
        stream: false,
      });

      return {
        content: fromAnthropicContent(response.content),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: mapStopReason(response.stop_reason),
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 429) {
        const retryAfter = err.headers?.['retry-after'];
        const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
        throw new RateLimitError(err.message, retryMs);
      }
      throw err;
    }
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    // Buffer per-index tool input JSON deltas (multiple tools can interleave).
    const toolInputBuffers = new Map<number, string>();
    const toolMeta = new Map<number, { id: string; name: string }>();

    let stream: MessageStream;
    try {
      stream = this.client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        system: request.systemPrompt,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        })),
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 429) {
        throw new RateLimitError((err as Error).message);
      }
      throw err;
    }

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            const idx = event.index;
            toolMeta.set(idx, {
              id: event.content_block.id,
              name: event.content_block.name,
            });
            toolInputBuffers.set(idx, '');
            yield {
              type: 'tool_use_start',
              toolIndex: idx,
              toolId: event.content_block.id,
              toolName: event.content_block.name,
            };
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const existing = toolInputBuffers.get(event.index) ?? '';
            toolInputBuffers.set(event.index, existing + event.delta.partial_json);
            yield {
              type: 'tool_use_delta',
              toolIndex: event.index,
              inputDelta: event.delta.partial_json,
            };
          }
          break;

        case 'content_block_stop': {
          const buf = toolInputBuffers.get(event.index);
          if (buf !== undefined) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(buf) as Record<string, unknown>;
            } catch {
              // Leave as empty object if JSON is somehow malformed
            }
            yield {
              type: 'tool_use_end',
              toolIndex: event.index,
              toolInput: parsed,
            };
            toolInputBuffers.delete(event.index);
          }
          break;
        }

        case 'message_delta':
          if (event.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: 0, // input tokens come from message_start
                outputTokens: event.usage.output_tokens,
              },
            };
          }
          break;

        case 'message_start':
          if (event.message.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: event.message.usage.input_tokens,
                outputTokens: event.message.usage.output_tokens,
              },
            };
          }
          break;

        case 'message_stop':
          yield { type: 'message_stop' };
          break;
      }
    }

    // Check for rate limit errors from the stream
    try {
      await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 429) {
        throw new RateLimitError((err as Error).message);
      }
    }
  }
}

function toAnthropicMessages(
  messages: Message[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled via system param
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    } else {
      const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        } else if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          };
        } else {
          // tool_result
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          };
        }
      });
      result.push({ role: msg.role as 'user' | 'assistant', content: blocks });
    }
  }
  return result;
}

function fromAnthropicContent(
  content: Anthropic.ContentBlock[],
): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text } satisfies TextBlock);
    } else if (block.type === 'tool_use') {
      result.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      } satisfies ToolUseBlock);
    }
    // Skip thinking/redacted_thinking blocks
  }
  return result;
}

function mapStopReason(
  reason: string | null,
): ChatResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}
