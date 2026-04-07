// Local model provider (Ollama / vLLM / LM Studio) — OpenAI-compatible API.
// Thin wrapper: uses OpenAIProvider with a custom baseURL.
// The apiKey is set to 'local' as a dummy value; local servers ignore it.

import { OpenAIProvider } from './openai.js';
import type { LLMProvider, ChatRequest, ChatResponse, ChatChunk } from '../types.js';

export class LocalProvider implements LLMProvider {
  private inner: OpenAIProvider;

  constructor(baseURL: string) {
    this.inner = new OpenAIProvider('local', baseURL.replace(/\/?$/, '/v1'));
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.inner.chat(request);
  }

  streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    return this.inner.streamChat(request);
  }
}
