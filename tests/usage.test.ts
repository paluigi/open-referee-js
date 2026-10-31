import { describe, expect, it } from 'vitest';
import { BudgetExceeded, UsageLedger } from '../src/providers/usage';
import type { LLMResponse } from '../src/providers/base';

const PRICING = {
  'gpt-strong': { input: 2, output: 8 },
  'gpt-small': { input: 0.1, output: 0.4 },
};

function resp(promptTokens: number, completionTokens: number): LLMResponse {
  return {
    content: 'c',
    usage: { promptTokens, completionTokens },
    model: 'gpt-strong',
  };
}

describe('UsageLedger.estimateCost', () => {
  it('computes per-1M-token cost', () => {
    const ledger = new UsageLedger(5, PRICING);
    expect(
      ledger.estimateCost('gpt-strong', {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
      }),
    ).toBeCloseTo(2 + 4, 10);
    expect(
      ledger.estimateCost('gpt-small', {
        promptTokens: 1_000_000,
        completionTokens: 250_000,
      }),
    ).toBeCloseTo(0.1 + 0.1, 10);
  });

  it('treats unknown models and zero pricing as free', () => {
    const ledger = new UsageLedger(5, PRICING);
    expect(
      ledger.estimateCost('unknown-model', {
        promptTokens: 9_999,
        completionTokens: 9_999,
      }),
    ).toBe(0);
    const free = new UsageLedger(5, { m: { input: 0, output: 0 } });
    expect(free.estimateCost('m', { promptTokens: 1e9, completionTokens: 1e9 })).toBe(
      0,
    );
  });
});

describe('UsageLedger.budget', () => {
  it('does not throw while under the cap', () => {
    const ledger = new UsageLedger(5, PRICING);
    expect(() => ledger.checkBudget(4.99)).not.toThrow();
  });

  it('throws BudgetExceeded with fields when projected spend exceeds the cap', () => {
    const ledger = new UsageLedger(5, PRICING);
    ledger.record('gpt-strong', 'strong', resp(1_000_000, 500_000)); // $6 spent already > cap
    try {
      ledger.checkBudget(0);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceeded);
      const err = e as BudgetExceeded;
      expect(err.capUsd).toBe(5);
      expect(err.estimatedCostUsd).toBeGreaterThan(5);
    }
  });

  it('accounts total spend when checking the budget', () => {
    const ledger = new UsageLedger(5, PRICING);
    ledger.record('gpt-strong', 'strong', resp(1_000_000, 0)); // $2
    expect(() => ledger.checkBudget(2.5)).not.toThrow(); // 4.5 <= 5
    expect(() => ledger.checkBudget(3.5)).toThrow(BudgetExceeded); // 5.5 > 5
  });

  it('capUsd=0 allows free calls but blocks any projected spend', () => {
    const ledger = new UsageLedger(0, PRICING);
    expect(() => ledger.checkBudget(0)).not.toThrow(); // empty ledger, zero projection
    expect(() => ledger.checkBudget(0.01)).toThrow(BudgetExceeded);
    // Free (unknown-model) calls never trip the cap.
    ledger.record('unknown-model', 'small', resp(1000, 1000));
    expect(ledger.totalCost()).toBe(0);
    expect(() => ledger.checkBudget(0)).not.toThrow();
  });

  it('negative usage from a broken provider is clamped, never credited', () => {
    const ledger = new UsageLedger(5, PRICING);
    ledger.record('gpt-strong', 'strong', resp(1_000_000, 0)); // $2
    ledger.record('gpt-strong', 'strong', resp(-5_000_000, -1_000_000)); // would be -$12
    expect(ledger.totalCost()).toBeCloseTo(2, 10); // clamped to 0, not reduced
  });
});

describe('UsageLedger.record and aggregation', () => {
  it('records calls and returns the CallRecord', () => {
    const ledger = new UsageLedger(5, PRICING);
    const rec = ledger.record('gpt-strong', 'strong', resp(1_000_000, 250_000));
    expect(rec).toEqual({
      model: 'gpt-strong',
      role: 'strong',
      usage: { promptTokens: 1_000_000, completionTokens: 250_000 },
      costUsd: 4,
      // 7c: the budget harness keys per-phase accounting on the call type.
      callType: 'other',
    });
    expect(ledger.calls).toEqual([rec]);
    // explicit call types tag through (Python complete_json(call_type=...))
    const tagged = ledger.record('gpt-strong', 'strong', resp(10, 10), 'meta');
    expect(tagged.callType).toBe('meta');
  });

  it('totalCost and totalTokens aggregate across calls', () => {
    const ledger = new UsageLedger(100, PRICING);
    ledger.record('gpt-strong', 'strong', resp(1_000_000, 0)); // 2
    ledger.record('gpt-small', 'small', resp(500_000, 250_000)); // 0.05+0.1
    expect(ledger.totalCost()).toBeCloseTo(2.15, 10);
    expect(ledger.totalTokens()).toEqual({
      prompt: 1_500_000,
      completion: 250_000,
    });
  });

  it('byRole aggregates calls, cost and tokens per role', () => {
    const ledger = new UsageLedger(100, PRICING);
    ledger.record('gpt-strong', 'strong', resp(1_000_000, 0));
    ledger.record('gpt-strong', 'strong', resp(0, 1_000_000));
    ledger.record('gpt-small', 'small', resp(1_000_000, 0));
    const byRole = ledger.byRole();
    expect(Object.keys(byRole).sort()).toEqual(['small', 'strong']);
    expect(byRole.strong).toEqual({
      calls: 2,
      costUsd: 2 + 8,
      tokens: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });
    expect(byRole.small).toEqual({
      calls: 1,
      costUsd: 0.1,
      tokens: { promptTokens: 1_000_000, completionTokens: 0 },
    });
  });
});
