import { describe, expect, it } from 'vitest';
import { UsageLedger } from '../src/providers/usage';
import type { CallRecord } from '../src/providers/usage';

describe('UsageLedger.restore (7c review R1)', () => {
  it('re-books persisted records so resumed spend accounting includes them', () => {
    const ledger = new UsageLedger(100);
    const rec: CallRecord = {
      model: 'm',
      role: 'strong',
      usage: { promptTokens: 100, completionTokens: 50 },
      costUsd: 0.25,
      callType: 'triage',
    };
    ledger.restore([rec]);
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.totalCost()).toBeCloseTo(0.25, 10);
    expect(ledger.totalTokens()).toEqual({ prompt: 100, completion: 50 });
    expect(ledger.byRole()['strong']?.calls).toBe(1);
    // a new call appends after the restored records
    ledger.record(
      'm',
      'small',
      {
        content: '{}',
        usage: { promptTokens: 10, completionTokens: 5 },
      } as never,
      'validate',
    );
    expect(ledger.calls).toHaveLength(2);
  });
});
