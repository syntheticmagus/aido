export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    shouldRetry = () => true,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      // Full jitter: random delay in [0, min(maxDelay, base * 2^attempt)]
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delay = Math.random() * cap;
      await sleep(delay);
    }
  }
  throw lastErr;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}
