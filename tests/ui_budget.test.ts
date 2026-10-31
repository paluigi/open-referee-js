/** Stage 7c UI tests: budget tier selector, spend line, top-up control. */

import { beforeEach, describe, expect, it } from 'vitest';
import { projectedCost, spendSoFarLine, topUpControl } from '../src/ui/app';
import { ProgressController } from '../src/ui/progress';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
import { readMarkdown } from '../src/ingestion/readers_md';
import type { RunState } from '../src/pipeline/state';

function settings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    pricing: {
      'm-strong': { input: 3, output: 15 },
      'm-small': { input: 0.5, output: 2 },
    },
    roles: {
      strong: { provider: 'p', model: 'm-strong' },
      small: { provider: 'p', model: 'm-small' },
      vision: { provider: '', model: '' },
    },
    ...partial,
  };
}

const MD =
  '# T\n\n## A\n\n' + 'x'.repeat(600) + '\n\n## B\n\n' + 'y'.repeat(600) + '\n';

describe('projectedCost', () => {
  it('returns null without a doc', () => {
    expect(projectedCost(settings(), null)).toBeNull();
  });

  it('estimates all three presets from the cost model (no LLM)', () => {
    const doc = readMarkdown(MD);
    const est = projectedCost(settings(), doc)!;
    expect(Object.keys(est.estimates).sort()).toEqual(['deep', 'fast', 'standard']);
    // monotone: deep >= standard >= fast for the same doc
    expect(est.estimates['deep']).toBeGreaterThanOrEqual(est.estimates['standard']!);
    expect(est.estimates['standard']).toBeGreaterThanOrEqual(est.estimates['fast']!);
    // deterministic
    expect(projectedCost(settings(), doc)).toEqual(est);
  });
});

describe('spendSoFarLine', () => {
  it('sums persisted ledger calls and names the cap + target', () => {
    const st = {
      ledgerCalls: [
        {
          role: 'strong',
          callType: 'triage',
          inputTokens: 100,
          outputTokens: 10,
          costUsd: 0.01,
        },
        {
          role: 'small',
          callType: 'surveyor',
          inputTokens: 200,
          outputTokens: 20,
          costUsd: 0.002,
        },
      ],
      plan: { budget_usd: 5, target_usd: 1.5 },
    } as unknown as RunState;
    const line = spendSoFarLine(st);
    expect(line).toContain('$0.0120');
    expect(line).toContain('$5.00 cap');
    expect(line).toContain('$1.50');
  });

  it('omits cap/target when no plan is persisted', () => {
    const st = {
      ledgerCalls: [
        {
          role: 'strong',
          callType: 'triage',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0.5,
        },
      ],
    } as unknown as RunState;
    expect(spendSoFarLine(st)).toBe('Spent so far: $0.5000');
    expect(spendSoFarLine({} as RunState)).toBe('Spent so far: $0.0000');
  });
});

describe('topUpControl', () => {
  it('renders note + input + button and resumes with the raised cap', () => {
    document.body.innerHTML = '';
    const s = settings({ maxCostUsd: 1 });
    let resumed: number | undefined;
    const ctl = topUpControl({
      runState: { runId: 'r' } as RunState,
      settings: s,
      onResume: (v) => {
        resumed = v;
      },
    });
    document.body.appendChild(ctl);
    expect(ctl.querySelector('#budget-topup') ?? ctl).toBeDefined();
    expect(ctl.querySelector('.budget-topup-note')?.textContent).toContain(
      'raise the cap',
    );
    const input = ctl.querySelector<HTMLInputElement>('#topup-amount')!;
    const btn = ctl.querySelector<HTMLButtonElement>('#topup-resume')!;
    input.value = '7.5';
    btn.click();
    expect(resumed).toBe(7.5);
    // the raised cap persists and lifts the ledger cap too
    expect(s.budget?.budgetUsd).toBe(7.5);
    expect(s.maxCostUsd).toBe(7.5);
  });

  it('rejects non-positive amounts without resuming', () => {
    document.body.innerHTML = '';
    const s = settings();
    let resumed = 0;
    const ctl = topUpControl({
      runState: { runId: 'r' } as RunState,
      settings: s,
      onResume: (v) => {
        resumed = v;
      },
    });
    document.body.appendChild(ctl);
    const input = ctl.querySelector<HTMLInputElement>('#topup-amount')!;
    const btn = ctl.querySelector<HTMLButtonElement>('#topup-resume')!;
    input.value = '0';
    btn.click();
    expect(resumed).toBe(0);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('ProgressController spend line', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  it('spend line hidden until set, then visible with the text', () => {
    const c = new ProgressController(root);
    const line = root.querySelector<HTMLElement>('.progress-spend')!;
    expect(line.hidden).toBe(true);
    c.setSpend('Spent so far: $0.0120 of $5.00 cap');
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain('$0.0120');
    c.setSpend('');
    expect(line.hidden).toBe(true);
  });
});
