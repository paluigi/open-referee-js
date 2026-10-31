/**
 * Committee tests (Stage 7e): frontier feasibility, strategy ladder,
 * residual replanning, and the uncapped preset mode. Ports the scenarios of
 * Python tests/test_committee.py onto the TS BudgetHarness (pricing fixture
 * matches the upstream test: strong 3/15, small 0.3/2.5, decider 0.02/0).
 */

import { describe, expect, it } from 'vitest';
import {
  BudgetHarness,
  emptyDocStats,
  ledgerView,
  PRESET_KNOBS,
  type ResidualPath,
} from '../src/pipeline/budget';
import type { PricingEntry } from '../src/providers/usage';
import {
  CONFIRM_THRESHOLD,
  ESCALATION_CONFIDENCE,
  rankClaims,
  replanChoice,
  strategyCommittee,
  ReviewIncomplete,
  wrapupIncomplete,
  type CommitteeDeps,
} from '../src/pipeline/committee';
import { FakeDecisionProvider } from '../src/providers/decisions';
import type { DecisionCaller } from '../src/pipeline/orchestrator';
import { BudgetInfeasible } from '../src/pipeline/budget';
import { LLMError } from '../src/providers/base';

const PRICING: Record<string, PricingEntry> = {
  'fake/strong-fake': { input: 3.0, output: 15.0 },
  'fake/small-fake': { input: 0.3, output: 2.5 },
  'fakedec/decider-fake': { input: 0.02, output: 0.0 },
  // bare-model aliases (TS settings.pricing convention)
  'strong-fake': { input: 3.0, output: 15.0 },
  'small-fake': { input: 0.3, output: 2.5 },
  'decider-fake': { input: 0.02, output: 0.0 },
};

/**
 * The upstream test_committee fixture builds its RolePool with the STRONG
 * role only — pool.specs carries strong (priced) but NO small entry, so
 * small-role units cost 0 in the harness (Python _price returns (0,0) for
 * unconfigured roles). Mirror that here; the decider spec is injected per
 * test (make_harness mirrors `h.specs[DECISION] = pool.decider_spec`).
 */
const SPECS: Record<string, { provider: string; model: string }> = {
  strong: { provider: 'fake', model: 'strong-fake' },
};

const STATS = emptyDocStats({
  chars: 60_000,
  n_sections: 8,
  n_figures: 3,
  n_tables: 2,
  n_references: 30,
  n_theorems: 0,
  n_claims: 60,
  n_lenses: 3,
});

class MockLedger {
  readonly calls: {
    role: string;
    usage: { promptTokens: number; completionTokens: number };
    costUsd: number;
    callType: string;
  }[] = [];

  priceFor(key: string): PricingEntry | undefined {
    return PRICING[key] ?? PRICING[key.split('/').pop() ?? key];
  }

  record(
    role: string,
    callType: string,
    inTok: number,
    outTok: number,
    overrideCost?: number,
  ): number {
    // role → fixture model map (strong/small → *-fake, decision → decider-fake)
    const model = role === 'decision' ? 'decider-fake' : `${role}-fake`;
    const p = this.priceFor(`${role}/${model}`) ?? { input: 0, output: 0 };
    const costUsd = overrideCost ?? (inTok * p.input + outTok * p.output) / 1_000_000;
    this.calls.push({
      role,
      usage: { promptTokens: inTok, completionTokens: outTok },
      costUsd,
      callType,
    });
    return costUsd;
  }

  totalCost(): number {
    return this.calls.reduce((s, c) => s + c.costUsd, 0);
  }
}

function makeHarness(budget: number, ledger = new MockLedger()): BudgetHarness {
  const h = new BudgetHarness(ledgerView(ledger, PRICING), SPECS, budget, true);
  h.stats = emptyDocStats(STATS);
  return h;
}

/** Wire a FakeDecisionProvider into a DecisionCaller + book its usage. */
function wireDecider(
  fake: FakeDecisionProvider,
  harness: BudgetHarness,
  ledger: MockLedger,
): DecisionCaller {
  return async (input, questions, callType) => {
    const res = await fake.decide(input, questions);
    ledger.record(
      'decision',
      callType,
      res.usage.promptTokens,
      res.usage.completionTokens,
    );
    harness.note_record({
      callType,
      inputTokens: res.usage.promptTokens,
      outputTokens: res.usage.completionTokens,
      costUsd: 0,
    });
    return res;
  };
}

interface CallRecordLite {
  kind: 'callJson' | 'emit';
  role?: string;
  system?: string;
  user?: string;
  callType?: string;
  message?: string;
}

function makeDeps(
  harness: BudgetHarness,
  ledger: MockLedger,
  decider?: DecisionCaller,
) {
  const calls: CallRecordLite[] = [];
  const deps: CommitteeDeps & { calls: CallRecordLite[] } = {
    calls,
    callJson: async (role, system, user, opts) => {
      calls.push({ kind: 'callJson', role, system, user, callType: opts?.callType });
      // default reflection reply
      return {
        kind: 'ok',
        value: {
          draft: 'd',
          critique: 'c',
          evaluation_summary: 'lean',
          preferred_path: 'claims-light',
        },
      };
    },
    decide: decider
      ? async (input, questions, callType) => {
          calls.push({ kind: 'callJson', callType });
          return decider(input, questions, callType);
        }
      : undefined,
    harness,
    emit: async (message) => {
      calls.push({ kind: 'emit', message });
    },
    triage: { domain: 'economics' },
    syncBudgetToState: () => undefined,
  };
  return deps;
}

const CLAIMS = Array.from({ length: 20 }, (_, i) => ({
  id: `cl${String(i + 1).padStart(2, '0')}`,
  type: 'numerical',
  importance: 'central',
  components: { x: 1 },
  anchor: `a${i}`,
}));

// ------------------------------------------------------------------- frontier --

describe('frontier (feasible by construction)', () => {
  it('every path fits the reserve-adjusted budget; claims capped by the doc', () => {
    const h = makeHarness(2.0);
    const frontier = h.frontier(10);
    expect(frontier.length).toBeGreaterThanOrEqual(1);
    expect(frontier.length).toBeLessThanOrEqual(10);
    expect(new Set(frontier.map((p) => p.name)).size).toBe(frontier.length);
    for (const p of frontier) {
      expect(p.est_cost_usd).toBeLessThanOrEqual(h.effective_budget());
      expect(p.claims_count).toBeLessThanOrEqual(60);
    }
  });

  it('a generous budget keeps the depth-maximal and breadth-heavy ends', () => {
    const h = makeHarness(50.0);
    const names = new Set(h.frontier().map((p) => p.name));
    expect(names.has('maximal')).toBe(true);
    expect(names.has('lean-core')).toBe(true);
  });

  it('frontier is empty when the budget is too small', () => {
    const h = makeHarness(0.001);
    expect(h.frontier()).toEqual([]);
  });

  it('preset estimates are mechanical and ordered', () => {
    const h = makeHarness(50.0);
    const est = h.preset_estimates();
    expect(Object.keys(est).sort()).toEqual(['deep', 'fast', 'standard']);
    expect(est['fast']!).toBeGreaterThan(0);
    expect(est['fast']!).toBeLessThan(est['standard']!);
    expect(est['deep']!).toBeGreaterThanOrEqual(est['standard']!);
  });

  it('path_to_plan commits a frontier-based plan with a committee adjustment', () => {
    const h = makeHarness(2.0);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    const fr = h.frontier(10);
    const plan = h.path_to_plan(fr[0]!, 'strategy-committee', 'lean');
    expect(plan.based_on).toBe('frontier');
    expect(plan.target_usd).toBeLessThanOrEqual(h.effective_budget());
    expect(plan.planner_calls_max).toBe(10_000);
    expect(plan.adjustments[0]).toMatchObject({
      reason: 'strategy-committee',
      action: `frontier:${fr[0]!.name}`,
      source: 'committee',
    });
    expect(h.plan_log.map((e) => e['reason'])).toContain(`frontier:${fr[0]!.name}`);
  });
});

// ------------------------------------------------------------ strategy committee --

describe('strategy committee', () => {
  it('reflect → choose → confirm commits the DM-chosen path', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(2.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    const fake = new FakeDecisionProvider('decider-fake');
    fake.queue([
      {
        type: 'choice',
        name: 'path_choice',
        choice: 'claims-light',
        confidence: 0.9,
        probabilities: [],
      },
    ]);
    fake.queue([
      { type: 'predicate', name: 'confirm_path', probability: 0.85, probabilities: [] },
    ]);
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    const { path, plan } = await strategyCommittee(deps, CLAIMS);
    // Python parity at this budget: 'claims-light' does NOT fit the $2
    // frontier (est 1.801 > effective 1.7955), so the DM's choice name is
    // unknown → _dm_choose_path returns None → confirm never runs →
    // fallback picks frontier[-1] (the LLM's 'preferred' is also unknown).
    expect(path.name).toBe('triage-plus-lenses');
    expect((plan as { based_on: string }).based_on).toBe('frontier');
    // only the DM choice ran; confirm was skipped (chosen = None)
    expect(fake.calls.map((c) => c.questions)).toEqual([['path_choice']]);
    expect(ledger.calls.some((c) => c.callType === 'dm_steer')).toBe(true);
    expect(ledger.calls.some((c) => c.callType === 'dm_confirm')).toBe(false);
    expect(
      deps.calls.some((c) => c.kind === 'callJson' && c.callType === 'planner'),
    ).toBe(true);
  });

  it('rejection (confirm < 0.5) runs exactly one more DM round that commits', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(2.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    const fake = new FakeDecisionProvider('decider-fake');
    fake.queue([
      {
        type: 'choice',
        name: 'path_choice',
        choice: 'fast-scan',
        confidence: 0.9,
        probabilities: [],
      },
    ]);
    fake.queue([
      { type: 'predicate', name: 'confirm_path', probability: 0.3, probabilities: [] },
    ]);
    fake.queue([
      {
        type: 'choice',
        name: 'path_choice',
        choice: 'lean-core',
        confidence: 0.9,
        probabilities: [],
      },
    ]);
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    const { path } = await strategyCommittee(deps, CLAIMS);
    // first choice 'fast-scan' IS in the frontier → confirm 0.3 < 0.5 rejects
    // → one more DM round over ALL paths → 'lean-core' commits as-is.
    expect(path.name).toBe('lean-core');
    expect(fake.calls).toHaveLength(3); // choose + rejected confirm + second choose
  });

  it('without a decider the LLM preferred path commits (labelled fallback)', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(2.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    const deps = makeDeps(h, ledger); // no decider
    const { path, reflection } = await strategyCommittee(deps, CLAIMS);
    // reflection ran (no commit authority); the LLM's preferred name is not
    // in the $2 frontier → Python's fallback picks frontier[-1].
    expect(reflection['preferred']).toBe('claims-light');
    expect(path.name).toBe('triage-plus-lenses');
    expect(h.plan?.based_on).toBe('frontier');
  });

  it('an empty frontier raises BudgetInfeasible before any commit', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(0.001, ledger);
    // upstream: no preflight plan here — the frontier itself is empty
    expect(h.frontier()).toEqual([]);
    const deps = makeDeps(h, ledger);
    await expect(strategyCommittee(deps, CLAIMS)).rejects.toThrow(BudgetInfeasible);
  });
});

// ------------------------------------------------------------- claim ranking --

describe('rankClaims', () => {
  it('orders by the DM score rubric, DM wins over coarse importance', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(50.0, ledger);
    const fake = new FakeDecisionProvider('decider-fake');
    // cl01 scores low, cl02 scores critical -> order flips
    fake.queue([
      {
        type: 'score',
        name: 'claim_cl01',
        score: 0,
        confidence: 0.9,
        probabilities: [],
      },
      {
        type: 'score',
        name: 'claim_cl02',
        score: 3,
        confidence: 0.9,
        probabilities: [],
      },
    ]);
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    const ranked = await rankClaims(deps, [
      {
        id: 'cl01',
        type: 'numerical',
        importance: 'central',
        components: {},
        anchor: 'a',
      },
      {
        id: 'cl02',
        type: 'theorem_proof',
        importance: 'supporting',
        components: {},
        anchor: 'b',
      },
    ]);
    expect(ranked.map((c) => c['id'])).toEqual(['cl02', 'cl01']);
    expect(ledger.calls.some((c) => c.callType === 'dm_rank')).toBe(true);
  });

  it('without a decider falls back to the inventory importance order', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(50.0, ledger);
    const deps = makeDeps(h, ledger);
    const ranked = await rankClaims(deps, [
      {
        id: 'a',
        type: 'numerical',
        importance: 'supporting',
        components: {},
        anchor: 'a',
      },
      {
        id: 'b',
        type: 'numerical',
        importance: 'central',
        components: {},
        anchor: 'b',
      },
    ]);
    expect(ranked.map((c) => c['id'])).toEqual(['b', 'a']);
  });

  it('a failing DM call degrades to the inventory order', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(50.0, ledger);
    const failing: DecisionCaller = async () => {
      throw new LLMError('decider down');
    };
    const deps = makeDeps(h, ledger, failing);
    const ranked = await rankClaims(deps, [
      {
        id: 'a',
        type: 'numerical',
        importance: 'supporting',
        components: {},
        anchor: 'a',
      },
      {
        id: 'b',
        type: 'numerical',
        importance: 'central',
        components: {},
        anchor: 'b',
      },
    ]);
    expect(ranked.map((c) => c['id'])).toEqual(['b', 'a']);
  });
});

// ------------------------------------------------------------- replan + wrap-up --

describe('replan + wrap-up', () => {
  function addSpend(h: BudgetHarness, ledger: MockLedger, ct: string, cost: number) {
    ledger.record('strong', ct, 1000, 500, cost);
    h.note_record({
      callType: ct,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: cost,
    });
  }

  it('residual paths are feasible; a single option auto-applies with no call', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(3.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    addSpend(h, ledger, 'triage', 0.02);
    addSpend(h, ledger, 'claim_inventory', 0.03);
    for (let i = 0; i < 10; i++) addSpend(h, ledger, 'claim_verify', 0.02);
    const paths: ResidualPath[] = h.residual_frontier();
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.projected_final_usd).toBeLessThanOrEqual(h.effective_budget());
    }
    // Now force a single feasible continuation by draining past everything else.
    const fake = new FakeDecisionProvider('decider-fake');
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    for (let i = 0; i < 12; i++) addSpend(h, ledger, 'claim_verify', 0.09);
    const tight = h.residual_frontier();
    expect(tight.length).toBeGreaterThanOrEqual(1);
    const applied = await replanChoice(deps, 'test overrun');
    expect(applied).toBe(true);
    expect(h.plan?.based_on).toBe('residual-frontier');
  });

  it('DM continuation choice under the confidence threshold escalates to the LLM', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(50.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    addSpend(h, ledger, 'triage', 0.02);
    const fake = new FakeDecisionProvider('decider-fake');
    fake.queue([
      {
        type: 'choice',
        name: 'continuation',
        choice: 'lean-finish',
        confidence: ESCALATION_CONFIDENCE - 0.1,
        probabilities: [],
      },
    ]);
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    const applied = await replanChoice(deps, 'overrun');
    expect(applied).toBe(true);
    // escalation: the strong consult ran (planner)
    expect(
      deps.calls.some((c) => c.kind === 'callJson' && c.callType === 'planner'),
    ).toBe(true);
    // the consult reply names lean-finish
    expect(h.plan?.adjustments[0]?.action).toBe('continuation:lean-finish');
  });

  it('confident DM choice applies without an LLM consultation', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(50.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    addSpend(h, ledger, 'triage', 0.02);
    const fake = new FakeDecisionProvider('decider-fake');
    fake.queue([
      {
        type: 'choice',
        name: 'continuation',
        choice: 'lean-finish',
        confidence: 0.9,
        probabilities: [],
      },
    ]);
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    await replanChoice(deps, 'overrun');
    expect(
      deps.calls.some((c) => c.kind === 'callJson' && c.callType === 'planner'),
    ).toBe(false);
    expect(h.plan?.adjustments[0]?.action).toBe('continuation:lean-finish');
  });

  it('wrap-up carries the shortfall and returns ReviewIncomplete', async () => {
    const ledger = new MockLedger();
    const h = makeHarness(2.0, ledger);
    h.set_plan(h.deterministic_plan('preflight'), 'preflight-v0');
    addSpend(h, ledger, 'triage', 0.02);
    addSpend(h, ledger, 'claim_inventory', 0.03);
    for (let i = 0; i < 12; i++) addSpend(h, ledger, 'claim_verify', 0.15);
    expect(h.residual_frontier()).toEqual([]);
    expect(h.shortfall()).toBeGreaterThan(0);
    const fake = new FakeDecisionProvider('decider-fake');
    const deps = makeDeps(h, ledger, wireDecider(fake, h, ledger));
    const depsExtra = Object.assign(deps, {
      assemble: async (draft: Record<string, unknown>) => ({
        overall: draft['overall_feedback'],
      }),
      manuscriptTitle: 'T',
      manuscriptText: 'M',
      candidates: [],
      stagesDone: { triage: 'done' },
    });
    const result: ReviewIncomplete = await wrapupIncomplete(depsExtra, 'test');
    expect(result).toBeInstanceOf(ReviewIncomplete);
    expect(result.shortfall_usd).toBeGreaterThan(0);
    expect(result.cause_).toBe('test');
    // the wrap-up synthesis consulted the strong model
    expect(
      deps.calls.some((c) => c.kind === 'callJson' && c.callType === 'wrapup'),
    ).toBe(true);
  });
});

// ------------------------------------------------------------ uncapped presets --

describe('uncapped preset mode', () => {
  it('preset plans never replan and the gates stay open', () => {
    const ledger = new MockLedger();
    const h = new BudgetHarness(
      ledgerView(ledger, PRICING),
      {
        strong: { provider: 'fake', model: 'strong-fake' },
        small: { provider: 'fake', model: 'small-fake' },
      },
      0.05,
      false, // NOT auto
    );
    h.stats = emptyDocStats({ chars: 60_000, n_claims: 60 });
    h.set_plan(h.preset_plan(PRESET_KNOBS['standard']!, 'standard'), 'preset-tracking');
    ledger.record('strong', 'claim_verify', 5_000_000, 1_000_000);
    h.note_record({
      callType: 'claim_verify',
      inputTokens: 5_000_000,
      outputTokens: 1_000_000,
      costUsd: 1_000_000,
    });
    expect(h.should_replan()).toBeNull(); // no replanning in preset mode
    expect(h.allow_call('claim_verify')).toBe(true); // gates off
  });
});

// ----------------------------------------------------------------- constants --

describe('committee thresholds', () => {
  it('match the Python module constants', () => {
    expect(CONFIRM_THRESHOLD).toBe(0.5);
    expect(ESCALATION_CONFIDENCE).toBe(0.5);
  });
});
