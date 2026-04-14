import {
  GoogleGenerativeAI,
  type GenerateContentRequest,
  type Content,
  type Part,
} from '@google/generative-ai';
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

export class GoogleProvider implements LLMProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = this.client.getGenerativeModel({
      model: request.model,
      systemInstruction: request.systemPrompt,
    });

    const gcRequest = toGeminiRequest(request);

    try {
      const response = await model.generateContent(gcRequest);
      const candidate = response.response.candidates?.[0];
      if (!candidate) throw new Error('No candidates in Gemini response');

      const content = fromGeminiContent(candidate.content);
      const usage = response.response.usageMetadata;

      return {
        content,
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
        },
        stopReason: candidate.finishReason === 'STOP' ? 'end_turn' : 'end_turn',
      };
    } catch (err) {
      if ((err as Error).message?.includes('quota') || (err as Error).message?.includes('429')) {
        throw new RateLimitError((err as Error).message);
      }
      throw err;
    }
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = this.client.getGenerativeModel({
      model: request.model,
      systemInstruction: request.systemPrompt,
    });

    const gcRequest = toGeminiRequest(request);

    const { stream } = await model.generateContentStream(gcRequest);

    let toolIndex = 0;
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;

      for (const part of candidate.content.parts) {
        if ('text' in part && part.text) {
          yield { type: 'text_delta', delta: part.text };
        } else if ('functionCall' in part && part.functionCall) {
          const idx = toolIndex++;
          const id = `gemini-tool-${idx}`;
          yield {
            type: 'tool_use_start',
            toolIndex: idx,
            toolId: id,
            toolName: part.functionCall.name,
          };
          yield {
            type: 'tool_use_end',
            toolIndex: idx,
            toolInput: part.functionCall.args as Record<string, unknown>,
          };
        }
      }

      const usage = chunk.usageMetadata;
      if (usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
          },
        };
      }
    }

    yield { type: 'message_stop' };
  }
}

function toGeminiRequest(request: ChatRequest): GenerateContentRequest {
  const contents: Content[] = [];

  for (const msg of request.messages) {
    if (msg.role === 'system') continue; // handled via systemInstruction
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      contents.push({ role, parts: [{ text: msg.content }] });
    } else {
      const parts: Part[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: { name: block.name, args: block.input },
          } as Part);
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: block.tool_use_id,
              response: { content: block.content },
            },
          } as Part);
        }
      }
      if (parts.length > 0) contents.push({ role, parts });
    }
  }

  return {
    contents,
    tools: request.tools
      ? [{ functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema as unknown as import('@google/generative-ai').FunctionDeclarationSchema,
        }))}]
      : undefined,
    generationConfig: {
      temperature: request.temperature ?? 0.2,
      maxOutputTokens: request.maxTokens,
    },
  };
}

function fromGeminiContent(content: Content): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const part of content.parts ?? []) {
    if ('text' in part && part.text) {
      result.push({ type: 'text', text: part.text } satisfies TextBlock);
    } else if ('functionCall' in part && part.functionCall) {
      result.push({
        type: 'tool_use',
        id: `gemini-${part.functionCall.name}`,
        name: part.functionCall.name,
        input: part.functionCall.args as Record<string, unknown>,
      } satisfies ToolUseBlock);
    }
  }
  return result;
}
