import type { LLMResponse, Usage } from './base';

export interface PricingEntry {
  input: number;
  output: number;
}

export interface CallRecord {
  model: string;
  role: string;
  usage: Usage;
  costUsd: number;
  /**
   * Pipeline call type (Python CallRecord.call_type, default 'other'):
   * the budget harness keys empirical unit costs and per-phase accounting
   * on it. Stage 7c.
   */
  callType: string;
}

export class BudgetExceeded extends Error {
  readonly estimatedCostUsd: number;
  readonly capUsd: number;

  constructor(estimatedCostUsd: number, capUsd: number) {
    super(
      `Estimated cost $${estimatedCostUsd.toFixed(4)} would exceed the configured spend cap of $${capUsd.toFixed(2)}. Raise maxCostUsd to continue.`,
    );
    this.name = 'BudgetExceeded';
    this.estimatedCostUsd = estimatedCostUsd;
    this.capUsd = capUsd;
  }
}

/** Token accounting, cost estimation, and a spend cap checked before every call. */
export class UsageLedger {
  readonly calls: CallRecord[] = [];
  private readonly capUsd: number;
  private readonly pricing: Record<string, PricingEntry>;

  constructor(capUsd: number, pricing: Record<string, PricingEntry> = {}) {
    this.capUsd = capUsd;
    this.pricing = pricing;
  }

  /** Re-book restored records on resume (Python orchestrator.py:654-661
   * restores pool.ledger.calls from persisted state so pre-drain spend
   * stays in actual_cost/projected_final). Records are kept verbatim —
   * no re-pricing. */
  restore(records: readonly CallRecord[]): void {
    this.calls.push(...records);
  }

  estimateCost(model: string, usage: Usage): number {
    // Unknown models and zero-priced entries are free.
    const p = this.pricing[model];
    if (!p) return 0;
    return (
      (usage.promptTokens * p.input + usage.completionTokens * p.output) / 1_000_000
    );
  }

  checkBudget(projectedCostUsd: number): void {
    const projected = this.totalCost() + projectedCostUsd;
    if (projected > this.capUsd) {
      throw new BudgetExceeded(projected, this.capUsd);
    }
  }

  record(
    model: string,
    role: string,
    resp: LLMResponse,
    callType = 'other',
  ): CallRecord {
    // Clamp negative token counts from broken providers so a bad response
    // can never reduce the running cost.
    const usage: Usage = {
      promptTokens: Math.max(0, resp.usage.promptTokens),
      completionTokens: Math.max(0, resp.usage.completionTokens),
    };
    const costUsd = this.estimateCost(model, usage);
    const rec: CallRecord = { model, role, usage, costUsd, callType };
    this.calls.push(rec);
    return rec;
  }

  totalCost(): number {
    return this.calls.reduce((sum, c) => sum + c.costUsd, 0);
  }

  totalTokens(): { prompt: number; completion: number } {
    return this.calls.reduce(
      (acc, c) => ({
        prompt: acc.prompt + c.usage.promptTokens,
        completion: acc.completion + c.usage.completionTokens,
      }),
      { prompt: 0, completion: 0 },
    );
  }

  byRole(): Record<string, { calls: number; costUsd: number; tokens: Usage }> {
    const out: Record<string, { calls: number; costUsd: number; tokens: Usage }> = {};
    for (const c of this.calls) {
      const entry = (out[c.role] ??= {
        calls: 0,
        costUsd: 0,
        tokens: { promptTokens: 0, completionTokens: 0 },
      });
      entry.calls += 1;
      entry.costUsd += c.costUsd;
      entry.tokens.promptTokens += c.usage.promptTokens;
      entry.tokens.completionTokens += c.usage.completionTokens;
    }
    return out;
  }
}
