import type { ModelConfig, AgentRole, ModelsConfig } from '../config/schema.js';

interface BucketState {
  tokensConsumed: number;
  lastRefillTime: number;
}

export class ModelRouter {
  private buckets = new Map<string, BucketState>();

  constructor(private readonly config: ModelsConfig) {
    for (const model of config.models) {
      this.buckets.set(model.id, {
        tokensConsumed: 0,
        lastRefillTime: Date.now(),
      });
    }
  }

  selectModel(role: AgentRole, preferredId?: string): ModelConfig {
    this.refillBuckets();

    // 1. If preferred model is eligible and available, use it.
    if (preferredId) {
      const preferred = this.config.models.find((m) => m.id === preferredId);
      if (preferred && (preferred.roles.includes(role) || preferred.roles.includes('default'))) {
        return preferred;
      }
    }

    // 2. Filter models eligible for this role; fall back to 'default'-role models if none match.
    let eligible = this.config.models.filter((m) => m.roles.includes(role));
    if (eligible.length === 0) {
      eligible = this.config.models.filter((m) => m.roles.includes('default'));
    }
    if (eligible.length === 0) {
      throw new Error(`No model configured for role '${role}' and no default model is defined`);
    }

    const isComplex = role === 'architecture' || role === 'debug';

    // 3. Sort: models with headroom first, then by cost.
    const sorted = [...eligible].sort((a, b) => {
      const aHeadroom = this.headroom(a);
      const bHeadroom = this.headroom(b);
      const aAvail = aHeadroom > 0;
      const bAvail = bHeadroom > 0;

      if (aAvail !== bAvail) return aAvail ? -1 : 1;

      // Among available, sort by cost
      const aCost = a.costPer1kInput + a.costPer1kOutput;
      const bCost = b.costPer1kInput + b.costPer1kOutput;
      return isComplex ? bCost - aCost : aCost - bCost; // complex → expensive, simple → cheap
    });

    return sorted[0]!;
  }

  recordUsage(modelId: string, tokens: number): void {
    this.refillBuckets();
    const bucket = this.buckets.get(modelId);
    if (bucket) bucket.tokensConsumed += tokens;
  }

  getWaitTimeMs(modelId: string): number {
    this.refillBuckets();
    const model = this.config.models.find((m) => m.id === modelId);
    if (!model?.rateLimit) return 0;

    const h = this.headroom(model);
    if (h > 0) return 0;

    const bucket = this.buckets.get(modelId)!;
    const elapsed = Date.now() - bucket.lastRefillTime;
    return Math.max(0, 60_000 - elapsed);
  }

  private headroom(model: ModelConfig): number {
    if (!model.rateLimit) return Infinity;
    const bucket = this.buckets.get(model.id);
    if (!bucket) return Infinity;
    return model.rateLimit.tokensPerMinute - bucket.tokensConsumed;
  }

  private refillBuckets(): void {
    const now = Date.now();
    for (const model of this.config.models) {
      if (!model.rateLimit) continue;
      const bucket = this.buckets.get(model.id)!;
      const elapsedMs = now - bucket.lastRefillTime;
      const refill = (elapsedMs / 60_000) * model.rateLimit.tokensPerMinute;
      bucket.tokensConsumed = Math.max(0, bucket.tokensConsumed - refill);
      bucket.lastRefillTime = now;
    }
  }
}
