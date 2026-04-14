import OpenAI from 'openai';
import { RateLimitError } from '../../utils/retry.js';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  Message,
} from '../types.js';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey: apiKey || 'local', baseURL });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        messages: toOpenAIMessages(request),
        tools: request.tools?.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        stream: false,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error('No choice in OpenAI response');

      const content: ContentBlock[] = [];
      if (choice.message.content) {
        content.push({ type: 'text', text: choice.message.content } satisfies TextBlock);
      }
      for (const tc of choice.message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
        } satisfies ToolUseBlock);
      }

      return {
        content,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        stopReason: mapFinishReason(choice.finish_reason),
      };
    } catch (err) {
      if (err instanceof OpenAI.APIError && err.status === 429) {
        throw new RateLimitError(err.message);
      }
      throw err;
    }
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    // Buffer tool call inputs by index
    const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        messages: toOpenAIMessages(request),
        tools: request.tools?.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        stream: true,
      });
    } catch (err) {
      if (err instanceof OpenAI.APIError && err.status === 429) {
        throw new RateLimitError((err as Error).message);
      }
      throw err;
    }

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        yield { type: 'text_delta', delta: delta.content };
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        if (!toolBuffers.has(idx)) {
          toolBuffers.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          yield {
            type: 'tool_use_start',
            toolIndex: idx,
            toolId: tc.id ?? '',
            toolName: tc.function?.name ?? '',
          };
        }
        const buf = toolBuffers.get(idx)!;
        if (tc.id && !buf.id) buf.id = tc.id;
        if (tc.function?.name && !buf.name) buf.name = tc.function.name;
        if (tc.function?.arguments) {
          buf.args += tc.function.arguments;
          yield {
            type: 'tool_use_delta',
            toolIndex: idx,
            inputDelta: tc.function.arguments,
          };
        }
      }

      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        // Finalize all tool calls
        for (const [idx, buf] of toolBuffers) {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(buf.args) as Record<string, unknown>; } catch { /* */ }
          yield { type: 'tool_use_end', toolIndex: idx, toolInput: parsed };
        }
        toolBuffers.clear();
        yield { type: 'message_stop' };
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          },
        };
      }
    }
  }
}

function toOpenAIMessages(
  request: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (request.systemPrompt) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      messages.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : '' });
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else {
        // Check for tool_result blocks (OpenAI uses a different format)
        const toolResults = msg.content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            if (tr.type === 'tool_result') {
              messages.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id,
                content: tr.content,
              });
            }
          }
        } else {
          messages.push({
            role: 'user',
            content: msg.content
              .filter((b) => b.type === 'text')
              .map((b) => (b.type === 'text' ? b.text : ''))
              .join('\n'),
          });
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content });
      } else {
        const textBlocks = msg.content.filter((b) => b.type === 'text');
        const toolUseBlocks = msg.content.filter((b) => b.type === 'tool_use');
        messages.push({
          role: 'assistant',
          content: textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('') || null,
          tool_calls: toolUseBlocks.length > 0
            ? toolUseBlocks
                .filter((b) => b.type === 'tool_use')
                .map((b) => {
                  if (b.type !== 'tool_use') return null!;
                  return {
                    id: b.id,
                    type: 'function' as const,
                    function: {
                      name: b.name,
                      arguments: JSON.stringify(b.input),
                    },
                  };
                })
                .filter(Boolean)
            : undefined,
        });
      }
    }
  }

  return messages;
}

function mapFinishReason(reason: string | null): ChatResponse['stopReason'] {
  switch (reason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}
