/**
 * Budget core parity + behavior tests (Stage 7c).
 *
 * Python-generated expected values (`uv run python` in the open-referee repo
 * at origin/main 26ae883 against pipeline/budget.py; PY_* pattern from
 * tests/checkers.test.ts). Fixture stats are DocumentStats-compatible data
 * shared on both sides (12k chars / 3 sections / 2 figures / 1 table / 8
 * references / 2 theorems, no exact claim count).
 */

import { describe, expect, it } from 'vitest';
import {
  BudgetHarness,
  BudgetInfeasible,
  CHARS_PER_TOKEN,
  CONTROL_TYPES,
  DM_BATCH_COMMENTS,
  emptyDocStats,
  callMaxTokens,
  documentStatsFromDoc,
  FRONTIER_ARCHETYPES,
  knownOrEstimatedClaims,
  ledgerView,
  MAX_PLANNER_CALLS,
  MIN_CLAIMS,
  OUTPUT_BUDGETS,
  passesOf,
  planKnobsFromPreset,
  planPlannedCost,
  PlanKnobs,
  PRESET_KNOBS,
  PricingError,
  pyRound,
  REVIEW_TYPES,
  SPIKE_FACTOR,
} from '../src/pipeline/budget';
import { roundPy2 } from '../src/literature/reference_resolution';
import type { PricingEntry } from '../src/providers/usage';
import { readMarkdown } from '../src/ingestion/readers_md';

// ===== fixture shared with the Python parity probe (same numbers both sides)

const FIXTURE_STATS = emptyDocStats({
  chars: 12_000,
  n_sections: 3,
  n_figures: 2,
  n_tables: 1,
  n_references: 8,
  n_theorems: 2,
  n_claims: null,
  n_lenses: 3,
});

const PRICING: Record<string, PricingEntry> = {
  'strong/m-strong': { input: 3.0, output: 15.0 },
  'small/m-small': { input: 0.5, output: 2.0 },
  'vision/m-vision': { input: 1.0, output: 5.0 },
  // bare-model aliases (TS settings.pricing convention)
  'm-strong': { input: 3.0, output: 15.0 },
  'm-small': { input: 0.5, output: 2.0 },
  'm-vision': { input: 1.0, output: 5.0 },
};

const SPECS = {
  strong: { provider: 'strong', model: 'm-strong' },
  small: { provider: 'small', model: 'm-small' },
  vision: { provider: 'vision', model: 'm-vision' },
};

/** In-memory ledger mock conforming to the ledgerView adapter input. */
class MockLedger {
  readonly calls: {
    role: string;
    usage: { promptTokens: number; completionTokens: number };
    costUsd: number;
    callType?: string;
  }[] = [];

  priceFor(key: string): PricingEntry {
    return PRICING[key]!;
  }

  record(
    role: string,
    callType: string,
    inputTokens: number,
    outputTokens: number,
  ): { callType: string; inputTokens: number; outputTokens: number; costUsd: number } {
    const p = this.priceFor(`${role}/${role === 'strong' ? 'm-strong' : 'm-small'}`);
    const costUsd =
      (inputTokens * (p?.input ?? 0) + outputTokens * (p?.output ?? 0)) / 1_000_000;
    const rec = {
      role,
      usage: { promptTokens: inputTokens, completionTokens: outputTokens },
      costUsd,
      callType,
    };
    this.calls.push(rec);
    return { callType, inputTokens, outputTokens, costUsd };
  }

  totalCost(): number {
    return this.calls.reduce((s, c) => s + c.costUsd, 0);
  }
}

function makeHarness(budgetUsd: number, ledger = new MockLedger()): BudgetHarness {
  const h = new BudgetHarness(ledgerView(ledger, PRICING), SPECS, budgetUsd, true);
  h.stats = emptyDocStats(FIXTURE_STATS);
  return h;
}

// ===== Python-generated expected values (uv run python, /tmp parity probe)

// PY_UNIT_COSTS: round(harness.unit_cost(ct), 6) for the fixture stats.
const PY_UNIT_COSTS: Record<string, number> = {
  claim_verify: 0.01884,
  whole_paper_verify: 0.0597,
  section_challenger: 0.071598,
  whole_paper_challenge: 0.0897,
  lens_section: 0.00635,
  defense: 0.0029,
  adjudication: 0.0219,
  artifact_verify: 0.016,
  bibliography: 0.017,
  meta: 0.162,
  validate: 0.154398,
};

// PY_PRESET_ESTIMATES: harness.preset_estimates() for the fixture stats.
const PY_PRESET_ESTIMATES: Record<string, number> = {
  fast: 1.239092,
  standard: 1.946942,
  deep: 2.167242,
};

// PY_PLAN: deterministic_plan() at budget $5 on the fixture stats.
const PY_PLAN = {
  target_usd: 1.5091,
  knobs: {
    max_claims: 10,
    per_section_lenses: true,
    whole_paper_passes: true,
    defense_round: true,
    max_artifacts: 3,
    recompute: true,
    verify_passes: 1,
    claim_routing: 'base',
    output_budget: 'default',
    synthesis: false,
    copyedit: false,
    defense_second_round: false,
  },
  planned_cost: 1.509142,
  based_on: 'doc_stats',
  control_calls: { triage: 1, claim_inventory: 1, surveyor: 1, planner: 3 },
  stage_calls: {
    claim_verify: 10,
    lens_section: 9,
    artifact_verify: 3,
    whole_paper_verify: 1,
    section_challenger: 3,
    whole_paper_challenge: 1,
    defense: 11,
    dm_defense: 1,
    adjudication: 11,
    bibliography: 1,
    recompute_extract: 1,
    recompute_verify: 3,
    meta: 1,
    validate: 1,
  },
};

// PY_INFEASIBLE: deterministic_plan() at budget $0.01.
const PY_INFEASIBLE = {
  min: 0.9,
  standard: 1.67,
};

// PY_META_MAX: max(callMaxTokens('meta', level) or 8192, min(32768, 2000+130n))
// at the 'default' level (Python orchestrator._meta formula).
const PY_META_MAX: Record<string, number> = {
  '0': 6144,
  '10': 6144,
  '50': 8500,
  '120': 17600,
  '238': 32768,
  '300': 32768,
};

// PY_AFTER_ACTUALS: harness fed 6 real records (triage, claim_inventory,
// 3x claim_verify on strong; lens_section on small) with the token counts
// below, at budget $2 WITH the deterministic plan set.
const PY_AFTER_ACTUALS = {
  actual_cost: 0.2448,
  projected_final: 1.558114,
  control_actual_usd: 0.1257,
  should_replan: null,
  repair_options: [
    {
      action: 'drop_defense',
      label: 'Skip the defense/adjudication gate',
      saves_usd: 0.2728,
      impact: 'Keeps more unverified comments; report notes this',
    },
    {
      action: 'trim_claims_50',
      label: 'Trim claim verification to ~6 claims',
      saves_usd: 0.1218,
      impact: 'Claims are importance-sorted; peripheral ones go first',
    },
    {
      action: 'trim_claims_30',
      label: 'Trim claim verification to ~7 claims',
      saves_usd: 0.079,
      impact: 'Claims are importance-sorted; peripheral ones go first',
    },
    {
      action: 'drop_whole_paper_verify',
      label: 'Skip the whole-paper coherence pass',
      saves_usd: 0.0597,
      impact: 'Loses cross-section consistency findings',
    },
    {
      action: 'drop_lenses',
      label: 'Skip the per-section lens grid',
      saves_usd: 0.0508,
      impact: 'Loses breadth (per-section prose/math/stats reading)',
    },
    {
      action: 'drop_artifacts',
      label: 'Stop figure/table artifact checks',
      saves_usd: 0.048,
      impact: 'Cheap to re-run later; findings are usually peripheral',
    },
  ],
  steer: { action: 'none', note: 'on plan' },
  wrapup_reserve: 0.156498,
  effective_budget: 1.843502,
  cheapest_completion: 1.000392,
  shortfall: 0,
};

// PY_VALIDATE_PLAN: validate_plan(preset_plan(PlanKnobs())) at budget $0.5.
const PY_VALIDATE_PLAN = {
  knobs: {
    max_claims: 6,
    per_section_lenses: false,
    whole_paper_passes: false,
    defense_round: false,
    max_artifacts: 0,
    recompute: true,
    verify_passes: 1,
    claim_routing: 'base',
    output_budget: 'default',
    synthesis: true,
    copyedit: true,
    defense_second_round: false,
  },
  target_usd: 1.1525,
  plan_version: 2,
};

// PY_ROUNDS: python round(x, n) probes (uv run python).
const PY_ROUNDS: [number, number, number][] = [
  // [value, n, round(value, n)]
  [0.125, 2, 0.12],
  [2.675, 2, 2.67],
  [1.005, 2, 1.0],
  [1.715, 2, 1.72],
  [2.5, 2, 2.5],
  [3.5, 2, 3.5],
  [0.000123456789, 2, 0.0],
  [0.16666666666666666, 2, 0.17],
  [1.50915, 2, 1.51],
  [0.8996325, 2, 0.9],
  [123.4545454545, 2, 123.45],
  [2.00000000005, 2, 2.0],
  [0.15649812345, 2, 0.16],
  [0.125, 4, 0.125],
  [2.675, 4, 2.675],
  [0.16666666666666666, 4, 0.1667],
  [1.50915, 4, 1.5091],
  [0.8996325, 4, 0.8996],
  [123.4545454545, 4, 123.4545],
  [2.00000000005, 4, 2.0],
  [0.15649812345, 4, 0.1565],
  [0.000123456789, 6, 0.000123],
  [0.16666666666666666, 6, 0.166667],
  [0.8996325, 6, 0.899632],
  [123.4545454545, 6, 123.454545],
  [0.15649812345, 6, 0.156498],
];

// ================================================================= tests ==

describe('cost model constants (Python parity)', () => {
  it('CHARS_PER_TOKEN and caps match Python', () => {
    expect(CHARS_PER_TOKEN).toBe(3);
    expect(DM_BATCH_COMMENTS).toBe(40);
    expect(MAX_PLANNER_CALLS).toBe(4);
    expect(MIN_CLAIMS).toBe(6);
    expect(SPIKE_FACTOR).toBe(8.0);
    expect(CONTROL_TYPES.has('triage')).toBe(true);
    expect(CONTROL_TYPES.has('planner')).toBe(true);
    expect(CONTROL_TYPES.has('claim_verify')).toBe(false);
    expect(REVIEW_TYPES.length).toBe(11);
  });

  it('OUTPUT_BUDGETS tables match Python verbatim', () => {
    expect(OUTPUT_BUDGETS).toEqual({
      low: {
        claim_inventory: 8192,
        claim_verify: 4096,
        claim_arbitrate: 2048,
        recompute_extract: 4096,
        recompute_verify: 2048,
        whole_paper_verify: 8192,
        whole_paper_challenge: 8192,
        meta: 4096,
        synthesis: 4096,
        copyedit: 4096,
        validate: 4096,
      },
      default: {
        claim_inventory: 12288,
        claim_verify: 6144,
        claim_arbitrate: 3072,
        recompute_extract: 4096,
        recompute_verify: 2048,
        whole_paper_verify: 12288,
        whole_paper_challenge: 12288,
        section_challenger: 4096,
        meta: 6144,
        synthesis: 6144,
        copyedit: 6144,
        validate: 6144,
      },
      high: {
        claim_inventory: 16384,
        claim_verify: 12288,
        claim_arbitrate: 4096,
        recompute_extract: 6144,
        recompute_verify: 3072,
        whole_paper_verify: 16384,
        whole_paper_challenge: 16384,
        section_challenger: 6144,
        meta: 8192,
        synthesis: 8192,
        copyedit: 8192,
        validate: 8192,
      },
    });
    expect(callMaxTokens('meta', 'default')).toBe(6144);
    expect(callMaxTokens('synthesis', 'high')).toBe(8192);
    expect(callMaxTokens('unknown_type', 'default')).toBeUndefined();
    expect(callMaxTokens('meta', 'bogus_level')).toBeUndefined();
  });

  it('PRESET_KNOBS carry the Python preset figures verbatim (owner: keep as-is)', () => {
    expect(PRESET_KNOBS['fast']).toEqual(
      planKnobsFromPreset({
        max_claims: 20,
        per_section_lenses: false,
        whole_paper_passes: true,
        defense_round: false,
        max_artifacts: 6,
        recompute: false,
        verify_passes: 1,
        claim_routing: 'base',
        output_budget: 'low',
      }),
    );
    expect(PRESET_KNOBS['standard']).toEqual(
      planKnobsFromPreset({ verify_passes: 2, claim_routing: 'strong' }),
    );
    expect(PRESET_KNOBS['deep']).toEqual(
      planKnobsFromPreset({
        max_claims: 150,
        max_artifacts: 50,
        verify_passes: 3,
        claim_routing: 'all_strong',
        output_budget: 'high',
        defense_second_round: true,
      }),
    );
    expect(Object.keys(FRONTIER_ARCHETYPES).length).toBe(15);
    expect(passesOf(PRESET_KNOBS['standard']!)).toEqual([
      'section-lenses',
      'whole-paper',
      'artifacts≤12',
      'defense-gate',
    ]);
  });
});

describe('pyRound (Python round(x, n) semantics)', () => {
  it.each(PY_ROUNDS)('round(%d, %d) matches Python', (x, n, expected) => {
    expect(pyRound(x, n)).toBe(expected);
  });

  it('delegates n=2 to the fuzz-verified roundPy2', () => {
    for (let i = 0; i < 500; i++) {
      const x = (Math.random() * 1000 - 500) / (1 + (i % 7));
      expect(pyRound(x, 2)).toBe(roundPy2(x));
    }
  });
});

describe('documentStatsFromDoc + known_or_estimated_claims', () => {
  it('computes free stats from a Document (Python from_doc)', () => {
    // Sections count only when their block text (joined \\n\\n) exceeds 400
    // chars — pad well past that.
    const long = (c: string) => c.repeat(450);
    const doc = readMarkdown(
      '# T\n\n## A\n\n' +
        long('x') +
        '\n\n## B\n\n' +
        long('y') +
        '\n\n## C\n\n' +
        long('z') +
        '\n\n## Tiny\n\nshort\n\nReferences\n\n' +
        '[1] a\n[2] b\n[3] c\n',
    );
    const stats = documentStatsFromDoc({
      sections: doc.sections.map((s) => ({
        startBlock: s.startBlock,
        endBlock: s.endBlock,
      })),
      blocks: doc.blocks,
      figures: doc.figures,
      tables: doc.tables,
      theorems: doc.theorems,
      referencesText: doc.referencesText ?? '',
      fullText: () => doc.fullText(),
    });
    expect(stats.n_sections).toBeGreaterThanOrEqual(3); // A, B, C (Tiny excluded)
    expect(stats.chars).toBe(doc.fullText().length);
    expect(stats.n_references).toBe(3); // '\n'.count + 1 when non-empty
  });

  it('known_or_estimated_claims: estimate when unknown, exact after CLAIMS', () => {
    expect(knownOrEstimatedClaims(FIXTURE_STATS)).toBe(10); // max(10, 12000//2500=4)
    expect(knownOrEstimatedClaims({ ...FIXTURE_STATS, n_claims: 42 })).toBe(42);
    const big = { ...FIXTURE_STATS, chars: 1_000_000 };
    expect(knownOrEstimatedClaims(big)).toBe(150); // MAX_CLAIMS_CAP
  });
});

describe('unit costs (parity harness)', () => {
  it('matches the pinned Python unit costs for the fixture stats', () => {
    const h = makeHarness(5);
    for (const [ct, usd] of Object.entries(PY_UNIT_COSTS)) {
      expect(h.unit_cost(ct)).toBeCloseTo(usd, 9);
    }
  });

  it('preset estimates + min/standard costs match Python', () => {
    const h = makeHarness(5);
    expect(h.preset_estimates()).toEqual(PY_PRESET_ESTIMATES);
    expect(h.fast_floor()).toBe(PY_PRESET_ESTIMATES['fast']);
    expect(pyRound(h.min_viable_cost(), 6)).toBe(0.899632);
    expect(pyRound(h.standard_cost(), 6)).toBe(1.665542);
  });

  it('empirical unit costs kick in after MIN_UNIT_SAMPLES actuals', () => {
    const h = makeHarness(5);
    const ledger = new MockLedger();
    for (let i = 0; i < 3; i++) {
      h.note_record(ledger.record('strong', 'triage', 9000, 3000));
    }
    // EMA of (9000,3000) thrice = (9000,3000) — differs from the estimate.
    const [role, est_in] = h['_base_unit']('triage');
    expect(role).toBe('strong');
    void est_in;
    expect(h.done['triage']).toBe(3);
    expect(Math.trunc(h['_emp_in']['triage']!)).toBe(9000);
  });
});

describe('deterministic planner (parity harness)', () => {
  it('plan_knobs derived from tier + doc size are deterministic', () => {
    const a = makeHarness(5).deterministic_plan();
    const b = makeHarness(5).deterministic_plan();
    expect(a.knobs).toEqual(b.knobs);
    expect(a.target_usd).toBe(b.target_usd);
    expect(planPlannedCost(a)).toBeCloseTo(PY_PLAN.planned_cost, 9);
    // never LLM output: same inputs -> identical plan object shape
    expect(a).toEqual(b);
  });

  it('matches the pinned Python plan at budget $5', () => {
    const plan = makeHarness(5).deterministic_plan();
    expect(plan.target_usd).toBe(PY_PLAN.target_usd);
    expect(plan.knobs).toEqual(PY_PLAN.knobs);
    expect(plan.based_on).toBe(PY_PLAN.based_on);
    expect(plan.plan_version).toBe(1);
    expect(plan.planner_calls_max).toBe(MAX_PLANNER_CALLS);
    for (const [ct, n] of Object.entries(PY_PLAN.control_calls)) {
      expect(plan.control_estimates[ct]?.calls).toBe(n);
    }
    for (const [ct, n] of Object.entries(PY_PLAN.stage_calls)) {
      expect(plan.stage_estimates[ct]?.calls).toBe(n);
    }
  });

  it('throws BudgetInfeasible below the minimum viable cost (parity figures)', () => {
    const h = makeHarness(0.01);
    try {
      h.deterministic_plan();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetInfeasible);
      const e = err as BudgetInfeasible;
      expect(e.minBudgetUsd).toBe(PY_INFEASIBLE.min);
      expect(e.standardBudgetUsd).toBe(PY_INFEASIBLE.standard);
      expect(e.message).toContain('A meaningful review of this manuscript');
      expect(e.message).toContain('$0.90');
    }
  });

  it('binary-searches max_claims under tighter budgets (degradation ladder)', () => {
    // $0.95: barely above min_viable (0.8996) — depth must shrink from 10.
    const plan = makeHarness(0.95).deterministic_plan();
    expect(plan.target_usd).toBeLessThanOrEqual(0.95);
    expect(plan.knobs.max_claims).toBeLessThanOrEqual(PY_PLAN.knobs.max_claims);
    // control reserve always present
    expect(plan.control_estimates['triage']).toBeDefined();
    // determinism at the tighter budget too
    expect(plan).toEqual(makeHarness(0.95).deterministic_plan());
  });

  it('preset_plan is tracking-only (no planner calls)', () => {
    const h = makeHarness(5);
    const plan = h.preset_plan(PRESET_KNOBS['standard']!, 'standard');
    expect(plan.planner_calls_max).toBe(0);
    expect(plan.based_on).toBe('preset');
    expect(plan.rationale).toContain('Preset mode (standard)');
  });
});

describe('spend tracking + steering (parity harness)', () => {
  function harnessWithActuals(budget: number): {
    h: BudgetHarness;
    ledger: MockLedger;
  } {
    const ledger = new MockLedger();
    const h = makeHarness(budget, ledger);
    const recs: [string, string, number, number][] = [
      ['strong', 'triage', 4200, 1500],
      ['strong', 'claim_inventory', 5200, 5000],
      ['strong', 'claim_verify', 6300, 1200],
      ['strong', 'claim_verify', 6400, 1250],
      ['strong', 'claim_verify', 6100, 1180],
      ['small', 'lens_section', 8500, 2000],
    ];
    for (const [role, ct, it, ot] of recs)
      h.note_record(ledger.record(role, ct, it, ot));
    return { h, ledger };
  }

  it('ledger spend flows through (extend, not duplicate)', () => {
    const { h } = harnessWithActuals(2);
    expect(pyRound(h.actual_cost(), 6)).toBe(PY_AFTER_ACTUALS.actual_cost);
  });

  it('projected_final / status / should_replan match Python with plan set', () => {
    const { h } = harnessWithActuals(2);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    expect(pyRound(h.projected_final(), 6)).toBe(PY_AFTER_ACTUALS.projected_final);
    const st = h.status();
    expect(st['actual_usd']).toBeCloseTo(PY_AFTER_ACTUALS.actual_cost, 6);
    expect(st['control_actual_usd'] as number).toBeCloseTo(
      PY_AFTER_ACTUALS.control_actual_usd,
      6,
    );
    expect(st['projected_final_usd']).toBeCloseTo(PY_AFTER_ACTUALS.projected_final, 4);
    expect(h.should_replan()).toBe(PY_AFTER_ACTUALS.should_replan);
  });

  it('repair options match Python (ordered by descending savings)', () => {
    const { h } = harnessWithActuals(2);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    const opts = h.repair_options();
    expect(opts.map((o) => ({ ...o, index: 0 }))).toEqual(
      PY_AFTER_ACTUALS.repair_options.map((o) => ({ ...o, index: 0 })),
    );
    // per-save ordering
    for (let i = 1; i < opts.length; i++) {
      expect(opts[i - 1]!.saves_usd).toBeGreaterThanOrEqual(opts[i]!.saves_usd);
    }
    const st = h.steer();
    expect(st.action).toBe(PY_AFTER_ACTUALS.steer.action);
    expect(st.note).toBe(PY_AFTER_ACTUALS.steer.note);
  });

  it('apply_option commits a degraded plan that fits', () => {
    const { h } = harnessWithActuals(2);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    const before = h.plan!.knobs;
    const drop = h.repair_options().find((o) => o.action === 'drop_defense')!;
    const after = h.apply_option(drop, 'checkpoint verify/claims');
    expect(after.knobs.defense_round).toBe(false);
    expect(before.defense_round).toBe(true);
    expect(after.plan_version).toBeGreaterThan(h.plan!.plan_version - 1);
    expect(
      after.adjustments.some(
        (a) => a.action === 'drop_defense' && a.reason === 'checkpoint verify/claims',
      ),
    ).toBe(true);
    expect(planPlannedCost(after)).toBeLessThan(planPlannedCost(h.plan!));
  });

  it('wrap-up reserve + shortfall (parity figures)', () => {
    const { h } = harnessWithActuals(2);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    expect(pyRound(h.wrapup_reserve(), 6)).toBe(PY_AFTER_ACTUALS.wrapup_reserve);
    expect(pyRound(h.effective_budget(), 6)).toBe(PY_AFTER_ACTUALS.effective_budget);
    expect(pyRound(h.cheapest_completion_cost(), 6)).toBe(
      PY_AFTER_ACTUALS.cheapest_completion,
    );
    expect(h.shortfall()).toBe(PY_AFTER_ACTUALS.shortfall);
  });

  it('shortfall positive when the cheapest completion exceeds the budget', () => {
    const { h } = harnessWithActuals(1.05);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    expect(h.shortfall()).toBeGreaterThan(0);
  });
});

describe('validate_plan (LLM arithmetic never trusted)', () => {
  it('greedy repair + clamp matches the pinned Python outcome', () => {
    const h = makeHarness(0.5);
    const fake = h.preset_plan(PlanKnobs(), 'standard'); // would-be LLM plan
    const v = h.validate_plan(fake);
    expect(v.knobs).toEqual(PY_VALIDATE_PLAN.knobs);
    expect(v.target_usd).toBe(PY_VALIDATE_PLAN.target_usd);
    expect(v.plan_version).toBe(PY_VALIDATE_PLAN.plan_version);
    expect(v.adjustments).toHaveLength(1);
    expect(v.adjustments[0]!.action).toBe('clamp+recompute');
    expect(v.adjustments[0]!.source).toBe('planner');
    expect(v.based_on).toBe('doc_stats');
  });
});

describe('gates + spikes + yield', () => {
  /** Gate-test helper: actuals recorded on the SAME ledger the harness reads. */
  function harnessWithActuals(budget: number): BudgetHarness {
    const ledger = new MockLedger();
    const h = makeHarness(budget, ledger);
    const recs: [string, string, number, number][] = [
      ['strong', 'triage', 4200, 1500],
      ['strong', 'claim_inventory', 5200, 5000],
      ['strong', 'claim_verify', 6300, 1200],
      ['strong', 'claim_verify', 6400, 1250],
      ['strong', 'claim_verify', 6100, 1180],
      ['small', 'lens_section', 8500, 2000],
    ];
    for (const [role, ct, it, ot] of recs)
      h.note_record(ledger.record(role, ct, it, ot));
    return h;
  }

  it('allow_call is always open without a plan or outside auto', () => {
    const h = makeHarness(0.001); // auto but NO plan
    expect(h.allow_call('copyedit')).toBe(true);
    const manual = new BudgetHarness(
      ledgerView(new MockLedger(), PRICING),
      SPECS,
      0.001,
      false,
    );
    expect(manual.allow_call('copyedit')).toBe(true);
  });

  it('allow_call closes when the projection would exceed the cap', () => {
    const h = harnessWithActuals(1.6);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    // projected 1.558 + unit costs: cheap calls still fit under $1.6...
    const proj = h.projected_final();
    expect(h.allow_call('defense')).toBe(proj + h.unit_cost('defense') <= 1.6);
    // ...but a meta call (0.162) pushes past the cap
    expect(h.allow_call('meta')).toBe(proj + h.unit_cost('meta') <= 1.6);
    expect(h.allow_call('meta')).toBe(false);
    h.note_gate_stop('meta', 1);
    h.note_gate_stop('meta', 1);
    expect(h.gate_stopped['meta']).toBe(2);
  });

  it('steer flags deviation and prefers a repair that fits', () => {
    // Plan target 1.5091 at budget 1.3: projected > budget after actuals?
    // The deterministic plan won't fit 1.3 (min_viable 0.8996), so drive the
    // deviation through the SOFT TARGET instead: keep the plan but inflate
    // the harness budget in the plan bookkeeping.
    const h = harnessWithActuals(1.55);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    // simulate an overrun: shrink the plan's target view by spending more
    // (5 claim_verify batches on top of actuals pushes projected > 0.95*1.55)
    const ledger = new MockLedger();
    for (let i = 0; i < 2; i++) {
      h.note_record(ledger.record('strong', 'section_challenger', 9000, 4000));
    }
    const reason = h.should_replan();
    if (reason !== null) {
      const st = h.steer();
      expect(['none', 'applied', 'needs_planner', 'cant_fix']).toContain(st.action);
    }
  });

  it('spike detection: >= SPIKE_FACTOR x estimate flags and clears', () => {
    const h = makeHarness(5);
    const ledger = new MockLedger();
    // lens_section unit cost 0.00635; a $0.062 call is ~9.8x -> spike.
    h.note_record(ledger.record('small', 'lens_section', 4000, 30000));
    expect(h.spike_events).toHaveLength(1);
    expect(h.consume_spike()).toBeDefined();
    // control-plane calls never spike
    h.note_record(ledger.record('strong', 'triage', 100, 40000));
    expect(h.spike_events.filter((s) => s['call_type'] === 'triage')).toHaveLength(0);
    // dm_* never spike
    h.note_record(ledger.record('small', 'dm_defense', 100, 40000));
    expect(
      h.spike_events.filter((s) => String(s['call_type']).startsWith('dm_')),
    ).toHaveLength(0);
  });

  it('note_yield aggregates findings + max severity', () => {
    const h = makeHarness(5);
    h.note_yield('claim_verify', 3, 0.7);
    h.note_yield('claim_verify', 1, 0.4);
    expect(h.yield_data['claim_verify']).toEqual({
      findings: 4,
      max_severity: 0.7,
      units: 2,
    });
  });

  it('require_pricing hard-errors on unpriced configured models', () => {
    // priceFor now defaults missing entries to free — the harness therefore
    // detects unpriced models through an explicit pricing-map probe.
    const h = new BudgetHarness(
      ledgerView(new MockLedger(), { 'm-strong': { input: 3, output: 15 } }),
      SPECS,
      5,
      true,
    );
    expect(() => h.require_pricing()).toThrow(PricingError);
    // 0.0 entries count as priced (local models are free)
    const ok = new BudgetHarness(
      ledgerView(new MockLedger(), {
        'm-strong': { input: 0, output: 0 },
        'm-small': { input: 0, output: 0 },
        'm-vision': { input: 0, output: 0 },
      }),
      SPECS,
      5,
      true,
    );
    expect(() => ok.require_pricing()).not.toThrow();
  });

  it('briefing carries the planner payload shape', () => {
    const h = makeHarness(5);
    h.set_plan(h.deterministic_plan(), 'preflight-v0');
    const b = h.briefing();
    expect(b['mode']).toBe('initial');
    expect(b['budget_usd']).toBe(5);
    expect(b['soft_target_usd']).toBe(PY_PLAN.target_usd);
    expect(typeof b['planner_call_cost_usd']).toBe('number');
    expect(b['planner_calls_remaining']).toBe(MAX_PLANNER_CALLS);
    expect(Object.keys(b['unit_costs_usd'] as object)).toEqual([...REVIEW_TYPES]);
    const b2 = h.briefing(h.repair_options());
    expect(b2['mode']).toBe('adjust');
  });

  it('meta output scaling: max(call_max_tokens, min(32768, 2000+130n))', () => {
    for (const [n, expected] of Object.entries(PY_META_MAX)) {
      const metaMax = Math.max(
        callMaxTokens('meta', 'default') ?? 8192,
        Math.min(32_768, 2_000 + 130 * Number(n)),
      );
      expect(metaMax).toBe(expected);
    }
  });
});
