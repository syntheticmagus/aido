import fs from 'node:fs';
import path from 'node:path';
import { estimateCost } from '../llm/cost-estimator.js';
import type { ModelConfig } from '../config/schema.js';

export interface BudgetState {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  remaining: number;
  percentUsed: number;
  startTime: number;
  elapsedMs: number;
}

export interface BudgetUpdate extends BudgetState {
  justExhausted: boolean;
  justWarned: boolean;
}

export class BudgetTracker {
  private totalCost = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private warned = false;
  private exhausted = false;
  private startTime = Date.now();
  private persistPath: string | null = null;

  constructor(
    private readonly maxTotalCost: number,
    private readonly warnAtCost?: number,
    private readonly maxWallClockMs?: number,
  ) {}

  setPersistPath(filePath: string): void {
    this.persistPath = filePath;
  }

  recordUsage(
    _agentId: string,
    model: ModelConfig,
    inputTokens: number,
    outputTokens: number,
  ): BudgetUpdate {
    const cost = estimateCost(inputTokens, outputTokens, model);
    this.totalCost += cost;
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;

    const justExhausted = !this.exhausted && this.totalCost >= this.maxTotalCost;
    if (justExhausted) this.exhausted = true;

    const justWarned =
      !this.warned &&
      this.warnAtCost !== undefined &&
      this.totalCost >= this.warnAtCost;
    if (justWarned) this.warned = true;

    const state = this.getState();
    this.persist();
    return { ...state, justExhausted, justWarned };
  }

  getState(): BudgetState {
    const elapsedMs = Date.now() - this.startTime;
    return {
      totalCost: this.totalCost,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      remaining: Math.max(0, this.maxTotalCost - this.totalCost),
      percentUsed: (this.totalCost / this.maxTotalCost) * 100,
      startTime: this.startTime,
      elapsedMs,
    };
  }

  isExhausted(): boolean {
    if (this.totalCost >= this.maxTotalCost) return true;
    if (this.maxWallClockMs && Date.now() - this.startTime >= this.maxWallClockMs) return true;
    return false;
  }

  shouldWarn(): boolean {
    return (
      !this.warned &&
      this.warnAtCost !== undefined &&
      this.totalCost >= this.warnAtCost
    );
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify(this.getState(), null, 2),
        'utf-8',
      );
    } catch {
      // Best effort
    }
  }
}
