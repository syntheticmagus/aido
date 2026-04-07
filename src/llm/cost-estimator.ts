import type { ModelConfig } from '../config/schema.js';

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: ModelConfig,
): number {
  return (
    (inputTokens / 1000) * model.costPer1kInput +
    (outputTokens / 1000) * model.costPer1kOutput
  );
}

// Pre-call token count estimate. NOT authoritative — use API usage response
// for accurate accounting. Anthropic/Google use different tokenizers than
// OpenAI's tiktoken, so we use a character-based approximation for them.
export function countTokens(text: string, provider: string): number {
  if (provider === 'openai' || provider === 'local') {
    // tiktoken import is expensive; use character approximation for now.
    // Average English token ≈ 4 chars for GPT models.
    return Math.ceil(text.length / 4);
  }
  // Anthropic/Google: ~3.5 chars per token empirically
  return Math.ceil(text.length / 3.5);
}
