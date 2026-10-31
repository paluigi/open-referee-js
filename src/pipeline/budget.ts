/**
 * Budget-driven planning harness: cost model, deterministic planner,
 * spend tracking, and steering for the review pipeline.
 *
 * Port of Python `open_referee/pipeline/budget.py` (origin/main 26ae883).
 * Two cost buckets are accounted separately:
 *
 * - control plane: triage, claim inventory, surveyor, and the planner LLM
 *   calls themselves (plus a small replanning contingency reserve);
 * - review plane: per-claim/lens/artifact verification, challenges, the
 *   defense gate, bibliography audit, meta and validation.
 *
 * Every LLM call in the run flows through the UsageLedger; the harness layers
 * plan-vs-actual tracking, adaptive unit costs, and deterministic steering on
 * top so that an LLM replanning call is a last resort, not the default
 * reaction to deviation — replanning costs money too, and that money comes
 * out of the same budget.
 *
 * Scope notes for the TS port (Stage 7c):
 * - The usage ledger is the existing `UsageLedger` (src/providers/usage.ts),
 *   extended with a per-call `callType` (Python CallRecord.call_type) and a
 *   `priceFor` lookup — the harness tracks ON TOP of it, it does not
 *   duplicate spend accounting.
 * - The planner LLM, committee and decision-model surfaces (Python
 *   `committee.py`, ModelRole.DECISION/AUDITOR, dm_* call types) are Stage
 *   7e+; their cost-model entries port (planner, dm_call, dm_defense,
 *   wrapup) so estimates and pricing stay parity-pinned, and the wrap-up
 *   reserve is honoured, but nothing issues those calls yet.
 * - Money rounding: Python rounds per-estimate costs with round(x, 6) —
 *   NOT round(x, 2). The only round(x, 2) sites are the BudgetInfeasible
 *   error figures and the status() display rounding (round(x, 4)). The
 *   exact-binary-expansion roundPy2 helper is reused for those display
 *   roundings (round(x, 4) is implemented as round-to-4 decimals on the
 *   exact binary expansion, see roundPyN).
 */

import { roundPy2 } from '../literature/reference_resolution';
import type { PricingEntry } from '../providers/usage';

// ----------------------------------------------------------------- constants --

/** Matches RolePool's pre-call estimate convention (orchestrator callJson). */
export const CHARS_PER_TOKEN = 3;

/**
 * defense-gate decision calls: comments per decide() batch (each batch
 * carries message/defense/passage excerpts, ~1.3k chars per comment,
 * keeping the decision context under the 60k-char API cap)
 */
export const DM_BATCH_COMMENTS = 40;
export const MAX_MANUSCRIPT_CHARS = 120_000;
/** 1 strategy call + up to 3 mid-run adjustments. */
export const MAX_PLANNER_CALLS = 4;
/** Reserve carved out for adjustments. */
export const PLANNER_CONTINGENCY_CALLS = 2;
/** A review below this is not meaningful. */
export const MIN_CLAIMS = 6;
/** math-ish claim types route to the strong role. */
export const CLAIM_VERIFY_STRONG_SHARE = 0.4;
/** Steer when projection exceeds 95% of budget. */
export const OVERRUN_BUDGET_FRACTION = 0.95;
/** The soft target may be exceeded by up to 20% silently. */
export const TARGET_TOLERANCE = 0.2;
/** Empirical unit costs kick in after N actual calls. */
export const MIN_UNIT_SAMPLES = 3;
/** Fixed estimate, matches claims.py's gate. */
export const VISION_TOKENS_PER_ARTIFACT = 4000;
export const MAX_CLAIMS_CAP = 150;
export const MAX_ARTIFACTS_CAP = 50;
/** A call costing >= 8x its estimate is a spike. */
export const SPIKE_FACTOR = 8.0;

/** call types that belong to the control plane (booked separately in the plan) */
export const CONTROL_TYPES: ReadonlySet<string> = new Set([
  'triage',
  'claim_inventory',
  'surveyor',
  'planner',
]);

/** review-plane call types, in the deterministic planner's quality order */
export const REVIEW_TYPES: readonly string[] = [
  'claim_verify',
  'whole_paper_verify',
  'section_challenger',
  'whole_paper_challenge',
  'lens_section',
  'defense',
  'adjudication',
  'artifact_verify',
  'bibliography',
  'meta',
  'validate',
];

// -------------------------------------------------------------------- errors --

/** A configured model has no pricing entry; budget planning is impossible. */
export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/** The budget cannot buy a meaningful review. */
export class BudgetInfeasible extends Error {
  readonly minBudgetUsd: number;
  readonly standardBudgetUsd: number;

  constructor(message: string, minBudgetUsd: number, standardBudgetUsd: number) {
    super(message);
    this.name = 'BudgetInfeasible';
    this.minBudgetUsd = minBudgetUsd;
    this.standardBudgetUsd = standardBudgetUsd;
  }
}

// -------------------------------------------------------------------- models --

/** Free (no-LLM) statistics driving all cost estimates. */
export interface DocumentStats {
  chars: number;
  n_sections: number;
  n_figures: number;
  n_tables: number;
  n_references: number;
  n_theorems: number;
  /** exact count known after the CLAIMS stage */
  n_claims?: number | null;
  /** exact count known after TRIAGE */
  n_lenses: number;
}

/** Python DocumentStats defaults. */
export function emptyDocStats(init: Partial<DocumentStats> = {}): DocumentStats {
  return {
    chars: 0,
    n_sections: 1,
    n_figures: 0,
    n_tables: 0,
    n_references: 0,
    n_theorems: 0,
    n_claims: null,
    n_lenses: 3,
    ...init,
  };
}

/** Minimal Document surface DocumentStats.from_doc needs. */
export interface StatsDoc {
  sections: { startBlock: number; endBlock: number }[];
  blocks: { text: string }[];
  figures: unknown[];
  tables: unknown[];
  theorems: unknown[];
  referencesText?: string | null;
  fullText(): string;
}

/** Python DocumentStats.from_doc: free statistics over the ingested doc. */
export function documentStatsFromDoc(doc: StatsDoc): DocumentStats {
  let n_sections = 0;
  if (doc.sections) {
    for (const s of doc.sections) {
      const text = doc.blocks
        .slice(s.startBlock, s.endBlock)
        .map((b) => b.text)
        .join('\n\n');
      if (text.length > 400) n_sections += 1;
    }
  }
  const refs = doc.referencesText ?? '';
  let n_references = 0;
  for (const ch of refs) if (ch === '\n') n_references += 1;
  if (refs.trim() !== '') n_references += 1;
  return {
    chars: doc.fullText().length,
    n_sections: Math.max(1, n_sections),
    n_figures: doc.figures.length,
    n_tables: doc.tables.length,
    n_references,
    n_theorems: doc.theorems.length,
    n_claims: null,
    n_lenses: 3,
  };
}

/** The adjustable dials of a review plan (superset of the depth presets). */
export interface PlanKnobs {
  max_claims: number;
  per_section_lenses: boolean;
  whole_paper_passes: boolean;
  defense_round: boolean;
  max_artifacts: number;
  /** hybrid formula recomputation (extract->sympy->verify) */
  recompute: boolean;
  /** independent verification passes per claim */
  verify_passes: number;
  /** base | strong (numerical->strong) | all_strong */
  claim_routing: string;
  /** low | default | high per-call-type budgets */
  output_budget: string;
  /** lead-referee essay pass over deduplicated comments */
  synthesis: boolean;
  /** language-mechanics annex (verbatim fixes) */
  copyedit: boolean;
  /** second defense pass on upheld comments */
  defense_second_round: boolean;
}

export function PlanKnobs(init: Partial<PlanKnobs> = {}): PlanKnobs {
  return {
    max_claims: 60,
    per_section_lenses: true,
    whole_paper_passes: true,
    defense_round: true,
    max_artifacts: 12,
    recompute: true,
    verify_passes: 1,
    claim_routing: 'base',
    output_budget: 'default',
    synthesis: true,
    copyedit: true,
    defense_second_round: false,
    ...init,
  };
}

/** Python PlanKnobs.from_preset: preset fields with getattr fallbacks. */
export function planKnobsFromPreset(preset: Partial<PlanKnobs>): PlanKnobs {
  return PlanKnobs({
    max_claims: preset.max_claims ?? 60,
    per_section_lenses: preset.per_section_lenses ?? true,
    whole_paper_passes: preset.whole_paper_passes ?? true,
    defense_round: preset.defense_round ?? true,
    max_artifacts: preset.max_artifacts ?? 12,
    recompute: preset.recompute ?? true,
    verify_passes: preset.verify_passes ?? 1,
    claim_routing: preset.claim_routing ?? 'base',
    output_budget: preset.output_budget ?? 'default',
    synthesis: preset.synthesis ?? true,
    copyedit: preset.copyedit ?? true,
    defense_second_round: preset.defense_second_round ?? false,
  });
}

/** Shallow copy-with-update (Python model_copy(update=...)). */
function knobsCopy(knobs: PlanKnobs, update: Partial<PlanKnobs>): PlanKnobs {
  return { ...knobs, ...update };
}

// per-call-type output budgets by depth level (tokens); calls not listed use
// the role default. Reasoning-style models need generous budgets or they
// exhaust the output window mid-thought (observed 2-5x underestimates).
export const OUTPUT_BUDGETS: Record<string, Record<string, number>> = {
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
};

export function callMaxTokens(callType: string, level: string): number | undefined {
  return OUTPUT_BUDGETS[level]?.[callType];
}

export interface StageEstimate {
  call_type: string;
  /** role label; blends render as "strong+small" */
  role: string;
  calls: number;
  est_input_tokens: number;
  est_output_tokens: number;
  est_cost_usd: number;
}

export interface PlanAdjustment {
  /** ISO 8601 timestamp */
  ts: string;
  /** what triggered the change */
  reason: string;
  /** what was changed */
  action: string;
  detail: string;
  /** planner | steering | fallback | milestone */
  source: string;
}

function planAdjustmentNow(
  reason: string,
  action: string,
  source: string,
  detail = '',
): PlanAdjustment {
  return { ts: new Date().toISOString(), reason, action, detail, source };
}

export interface ReviewPlan {
  plan_version: number;
  /** hard ceiling, never exceeded */
  budget_usd: number;
  /** soft target the run commits to */
  target_usd: number;
  knobs: PlanKnobs;
  control_estimates: Record<string, StageEstimate>;
  stage_estimates: Record<string, StageEstimate>;
  planner_calls_max: number;
  planner_calls_used: number;
  rationale: string;
  based_on: string;
  adjustments: PlanAdjustment[];
}

export function planAllEstimates(plan: ReviewPlan): Record<string, StageEstimate> {
  return { ...plan.control_estimates, ...plan.stage_estimates };
}

export function planPlannedCost(plan: ReviewPlan): number {
  let sum = 0;
  for (const e of Object.values(planAllEstimates(plan))) sum += e.est_cost_usd;
  return sum;
}

export interface RepairOption {
  index: number;
  /** machine name, applied via applyOption() */
  action: string;
  /** human description of what changes */
  label: string;
  /** projected savings on REMAINING calls */
  saves_usd: number;
  /** quality-impact note for the planner LLM */
  impact: string;
}

/** Result of the deterministic steering decision at a checkpoint. */
export class Steering {
  /** none | applied | needs_planner | cant_fix */
  readonly action: string;
  readonly applied: RepairOption | undefined;
  readonly options: RepairOption[];
  readonly note: string;

  constructor(
    action: string,
    applied?: RepairOption | undefined,
    options?: RepairOption[],
    note = '',
  ) {
    this.action = action;
    this.applied = applied;
    this.options = options ?? [];
    this.note = note;
  }
}

// -------------------------------------------------------------------- ledger --

/**
 * The subset of the usage ledger the harness reads. The TS UsageLedger is
 * extended (providers/usage.ts) with `callType` on CallRecord + `priceFor` —
 * this interface keeps the harness testable against any ledger conforming to
 * the Python UsageLedger surface it was ported from.
 */
export interface LedgerView {
  readonly calls: {
    role: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    callType: string;
  }[];
  /** Missing entry = unpriced (Python pricing dict membership); callers decide. */
  priceFor(key: string): PricingEntry | undefined;
  totalCost(): number;
}

// ------------------------------------------------------------------- harness --

/**
 * One per run. Owns planning + tracking on top of the UsageLedger.
 *
 * The harness is the primary steering mechanism: it computes plans and
 * repair options deterministically and only defers to the planner LLM when
 * there is a genuine judgment call (several viable options). All calls —
 * including the planner's own — are charged to the same budget.
 */
export class BudgetHarness {
  budget_usd: number;
  readonly auto: boolean;
  stats: DocumentStats;
  plan: ReviewPlan | undefined;
  /**
   * plan-version trajectory: one snapshot per setPlan() call, with the
   * spend at the moment of the change (estimation-history dataset)
   */
  readonly plan_log: Record<string, unknown>[] = [];
  /** call_type -> actual call count */
  readonly done: Record<string, number> = {};
  /** call_type -> units skipped by the affordance gate (for reporting) */
  readonly gate_stopped: Record<string, number> = {};
  /** observed review yield per call type (findings, max severity) for replans */
  readonly yield_data: Record<
    string,
    { findings: number; max_severity: number; units: number }
  > = {};
  /** booked calls that cost >= SPIKE_FACTOR x their estimate */
  readonly spike_events: Record<string, unknown>[] = [];

  private readonly ledger: LedgerView;
  private readonly specs: Record<string, { provider: string; model: string }>;
  /** call_type -> empirical token averages (EMA over actuals) */
  private readonly _emp_in: Record<string, number> = {};
  private readonly _emp_out: Record<string, number> = {};

  constructor(
    ledger: LedgerView,
    specs: Record<string, { provider: string; model: string }>,
    budget_usd: number,
    auto: boolean,
  ) {
    this.ledger = ledger;
    this.specs = specs;
    this.budget_usd = budget_usd;
    this.auto = auto;
    this.stats = emptyDocStats();
    this.plan = undefined;
  }

  // ------------------------------------------------------------ pricing --

  /** key is `${provider}/${model}` (Python ledger key convention). */
  private _price(role: string): [number, number] {
    const spec = this.specs[role];
    if (spec === undefined) return [0, 0]; // role not configured (e.g. no vision model)
    const p = this.ledger.priceFor(`${spec.provider}/${spec.model}`);
    // Unpriced (missing) entries are free, matching the ledger's estimateCost.
    return [p?.input ?? 0, p?.output ?? 0];
  }

  private _cost(role: string, in_tok: number, out_tok: number): number {
    const [pi, po] = this._price(role);
    return (in_tok * pi + out_tok * po) / 1_000_000;
  }

  /**
   * Hard-error on models with no pricing entry (auto/fit modes).
   *
   * An explicit 0.0 entry counts as priced (local models are free); a
   * missing key means the user never configured prices, and every cost
   * downstream would silently be zero.
   */
  require_pricing(): void {
    const missing: string[] = [];
    for (const role of ['strong', 'small', 'vision', 'decision']) {
      const spec = this.specs[role];
      if (spec === undefined) continue;
      const key = `${spec.provider}/${spec.model}`;
      // An explicitly-present entry (even 0.0) counts as priced.
      if (this.ledger.priceFor(key) === undefined) missing.push(`${role}=${key}`);
    }
    if (missing.length > 0) {
      const snippet = missing
        .map(
          (m) =>
            `  "${m.split('=', 2)[1]}": {input_per_mtok: 3.0, output_per_mtok: 15.0}`,
        )
        .join('\n');
      throw new PricingError(
        `Budget-driven planning needs prices for: ${missing.join(', ')}. ` +
          'Add entries to llm.pricing in your config, e.g.:\n' +
          snippet +
          '\n(Local models can be priced explicitly at 0.0.)',
      );
    }
  }

  // --------------------------------------------------------- unit costs --

  private _manuscript_tokens(): number {
    return Math.floor(
      Math.min(this.stats.chars, MAX_MANUSCRIPT_CHARS) / CHARS_PER_TOKEN,
    );
  }

  /** (role label, est input tokens, est output tokens) for one call. */
  private _base_unit(ct: string): [string, number, number] {
    const m = this._manuscript_tokens();
    const sec = Math.max(1, this.stats.n_sections);
    const avg_sec = Math.max(
      2000,
      Math.floor(Math.floor(this.stats.chars / sec) / CHARS_PER_TOKEN),
    );
    const lens_in =
      Math.min(Math.floor(40_000 / CHARS_PER_TOKEN), avg_sec) +
      Math.floor(6000 / CHARS_PER_TOKEN) +
      700;
    switch (ct) {
      case 'triage':
        return ['strong', m + 800, 1500];
      case 'claim_inventory':
        return ['strong', m + 1200, 5000];
      case 'claim_verify': {
        const in_tok =
          Math.floor(12_000 / CHARS_PER_TOKEN) +
          Math.floor(6600 / CHARS_PER_TOKEN) +
          600;
        return ['strong+small', in_tok, 1200];
      }
      case 'lens_section':
        return ['small', lens_in, 2000];
      case 'artifact_verify':
        return ['vision', VISION_TOKENS_PER_ARTIFACT + 2000, 2000];
      case 'whole_paper_verify':
        return ['strong', m + 900, 3000];
      case 'section_challenger': {
        const in_tok =
          Math.min(Math.floor(40_000 / CHARS_PER_TOKEN), avg_sec) +
          Math.floor(20_000 / CHARS_PER_TOKEN) +
          2700;
        return ['strong', in_tok, 2500];
      }
      case 'whole_paper_challenge':
        return ['strong', m + Math.floor(30_000 / CHARS_PER_TOKEN) + 900, 3000];
      case 'defense':
        return ['small', 2200, 900];
      case 'adjudication':
        return ['strong', 2800, 900];
      case 'bibliography':
        return ['small', 22_000, 3000];
      case 'meta':
        return ['strong', Math.floor(60_000 / CHARS_PER_TOKEN) + 14_000, 4000];
      case 'validate':
        return ['strong', m + Math.floor(80_000 / CHARS_PER_TOKEN) + 800, 4000];
      case 'surveyor':
        return ['small', 4000, 1500];
      case 'fit_assessment':
        return ['strong', m + 2000, 3000];
      case 'planner':
        return ['small', 6000, 1200];
      case 'wrapup':
        return ['strong', m + Math.floor(80_000 / CHARS_PER_TOKEN) + 1500, 4000];
      case 'recompute_extract':
        return ['small', 12_000, 2500];
      case 'recompute_verify':
        return ['strong', 3500, 1200];
      case 'claim_arbitrate':
        return ['strong', 8000, 1500];
      case 'synthesis':
        return ['strong', 18_000, 6000];
      case 'copyedit':
        return ['small', m + 800, 5000];
      case 'dm_call':
        return ['decision', 5000, 1];
      case 'dm_defense':
        // one decide() batch: DM_BATCH_COMMENTS comments with
        // message/defense/passage excerpts (~52k chars)
        return [
          'decision',
          Math.floor((DM_BATCH_COMMENTS * 1300) / CHARS_PER_TOKEN),
          1,
        ];
      default:
        return ['small', 4000, 1500];
    }
  }

  /**
   * Estimated USD for one more call of this type; empirical once we
   * have enough actuals (self-correcting estimates).
   */
  unit_cost(ct: string): number {
    const [role, est_in, est_out] = this._base_unit(ct);
    let in_tok: number;
    let out_tok: number;
    if ((this.done[ct] ?? 0) >= MIN_UNIT_SAMPLES && ct !== 'planner') {
      in_tok = Math.trunc(this._emp_in[ct]!);
      out_tok = Math.trunc(this._emp_out[ct]!);
    } else {
      in_tok = est_in;
      out_tok = est_out;
    }
    if (role.includes('+')) {
      // claim_verify blends strong/small
      const strong = this._cost('strong', in_tok, out_tok);
      const small = this._cost('small', in_tok, out_tok);
      return (
        CLAIM_VERIFY_STRONG_SHARE * strong + (1 - CLAIM_VERIFY_STRONG_SHARE) * small
      );
    }
    return this._cost(role, in_tok, out_tok);
  }

  // -------------------------------------------------------------- counts --

  private _est_comments(knobs: PlanKnobs): number {
    const n_claims_checked = Math.min(
      knobs.max_claims,
      knownOrEstimatedClaims(this.stats),
    );
    return Math.min(200, Math.ceil(n_claims_checked * 0.5) + this.stats.n_sections * 2);
  }

  private _call_counts(knobs: PlanKnobs): Record<string, number> {
    const claims = Math.min(knobs.max_claims, knownOrEstimatedClaims(this.stats));
    const has_vision = this.specs['vision'] !== undefined;
    const counts: Record<string, number> = {
      triage: 1,
      claim_inventory: this.stats.chars > 70_000 ? 2 : 1,
      surveyor: 1,
      planner: this.auto ? 1 + PLANNER_CONTINGENCY_CALLS : 0,
      claim_verify: claims * Math.max(1, knobs.verify_passes),
      claim_arbitrate: knobs.verify_passes > 1 ? Math.ceil(claims * 0.15) : 0,
      lens_section: knobs.per_section_lenses
        ? this.stats.n_sections * Math.max(1, this.stats.n_lenses)
        : 0,
      artifact_verify:
        has_vision && knobs.max_artifacts > 0
          ? Math.min(knobs.max_artifacts, this.stats.n_figures + this.stats.n_tables)
          : 0,
      whole_paper_verify: knobs.whole_paper_passes ? 1 : 0,
      section_challenger: this.stats.n_sections,
      whole_paper_challenge: 1,
      defense: knobs.defense_round
        ? this._est_comments(knobs) * (knobs.defense_second_round ? 2 : 1)
        : 0,
      dm_defense: knobs.defense_round
        ? Math.ceil(this._est_comments(knobs) / DM_BATCH_COMMENTS) *
          (knobs.defense_second_round ? 2 : 1)
        : 0,
      adjudication: knobs.defense_round ? this._est_comments(knobs) : 0,
      bibliography: this.stats.n_references > 0 ? 1 : 0,
      recompute_extract: knobs.recompute ? 1 : 0,
      recompute_verify: knobs.recompute ? 3 : 0,
      meta: 1,
      synthesis: knobs.synthesis ? 1 : 0,
      copyedit: knobs.copyedit ? 1 : 0,
      validate: 1,
    };
    const out: Record<string, number> = {};
    for (const [ct, n] of Object.entries(counts)) if (n > 0) out[ct] = n;
    return out;
  }

  private _estimates_for(
    knobs: PlanKnobs,
  ): [Record<string, StageEstimate>, Record<string, StageEstimate>] {
    const control: Record<string, StageEstimate> = {};
    const stages: Record<string, StageEstimate> = {};
    for (const [ct, n] of Object.entries(this._call_counts(knobs))) {
      const [role, est_in, est_out] = this._base_unit(ct);
      const cost = pyRound(n * this.unit_cost(ct), 6);
      const est: StageEstimate = {
        call_type: ct,
        role,
        calls: n,
        est_input_tokens: est_in * n,
        est_output_tokens: est_out * n,
        est_cost_usd: cost,
      };
      if (CONTROL_TYPES.has(ct)) control[ct] = est;
      else stages[ct] = est;
    }
    return [control, stages];
  }

  // ------------------------------------------------------ plan builders --

  min_viable_knobs(): PlanKnobs {
    return PlanKnobs({
      max_claims: MIN_CLAIMS,
      per_section_lenses: false,
      whole_paper_passes: false,
      defense_round: false,
      max_artifacts: 0,
      recompute: false,
      synthesis: false, // starved runs keep the meta merger's own overall
      copyedit: false,
    });
  }

  private _cost_of(knobs: PlanKnobs): number {
    const [control, stages] = this._estimates_for(knobs);
    let sum = 0;
    for (const e of Object.values({ ...control, ...stages })) sum += e.est_cost_usd;
    return sum;
  }

  min_viable_cost(): number {
    return this._cost_of(this.min_viable_knobs());
  }

  standard_cost(): number {
    return this._cost_of(PlanKnobs());
  }

  /**
   * Greedy quality ordering within the budget; carves out the control
   * reserve first. Also the fallback whenever the planner LLM fails.
   */
  deterministic_plan(reason = 'initial'): ReviewPlan {
    void reason;
    const control_only = this._cost_of(this.min_viable_knobs());
    if (this.budget_usd < control_only) {
      throw new BudgetInfeasible(
        `A meaningful review of this manuscript costs at least ` +
          `$${pyRound(control_only, 2).toFixed(2)} (control calls + ${MIN_CLAIMS} claim verifications + ` +
          `core synthesis), but the budget is $${pyRound(this.budget_usd, 2).toFixed(2)}.`,
        pyRound(control_only, 2),
        pyRound(this.standard_cost(), 2),
      );
    }
    let knobs = this.min_viable_knobs();
    const est_claims = knownOrEstimatedClaims(this.stats);
    // 1. claims: the primary engine — binary-search the affordable count
    let lo = MIN_CLAIMS;
    let hi = Math.min(est_claims, MAX_CLAIMS_CAP);
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (this._cost_of(knobsCopy(knobs, { max_claims: mid })) <= this.budget_usd)
        lo = mid;
      else hi = mid - 1;
    }
    knobs.max_claims = lo;
    // 2-5. cheap high-value passes, then breadth
    for (const update of [
      { whole_paper_passes: true },
      { defense_round: true },
      { recompute: true },
      { per_section_lenses: true },
      { max_artifacts: Math.min(12, this.stats.n_figures + this.stats.n_tables) },
    ] as Partial<PlanKnobs>[]) {
      const candidate = knobsCopy(knobs, update);
      if (this._cost_of(candidate) <= this.budget_usd) knobs = candidate;
    }
    const [control, stages] = this._estimates_for(knobs);
    return {
      plan_version: 1,
      budget_usd: this.budget_usd,
      target_usd: pyRound(this._cost_of(knobs), 4),
      knobs,
      control_estimates: control,
      stage_estimates: stages,
      planner_calls_max: MAX_PLANNER_CALLS,
      planner_calls_used: 0,
      rationale: 'Deterministic fallback plan: greedy quality ordering within budget.',
      based_on: this.stats.n_claims != null ? 'claims' : 'doc_stats',
      adjustments: [],
    };
  }

  /** Tracking-only plan for preset modes (no planner LLM involved). */
  preset_plan(knobs: PlanKnobs, depth_name: string): ReviewPlan {
    const [control, stages] = this._estimates_for(knobs);
    return {
      plan_version: 1,
      budget_usd: this.budget_usd,
      target_usd: pyRound(this._cost_of(knobs), 4),
      knobs,
      control_estimates: control,
      stage_estimates: stages,
      planner_calls_max: 0,
      planner_calls_used: 0,
      rationale: `Preset mode (${depth_name}); budget acts as cap only.`,
      based_on: 'preset',
      adjustments: [],
    };
  }

  // ------------------------------------------------------- plan handling --

  set_plan(plan: ReviewPlan, reason = ''): void {
    this.plan = plan;
    this.plan_log.push({
      ts: new Date().toISOString(),
      plan_version: plan.plan_version,
      based_on: plan.based_on,
      reason,
      target_usd: plan.target_usd,
      planned_usd: pyRound(planPlannedCost(plan), 6),
      knobs: { ...plan.knobs },
      spend_usd_at_change: pyRound(this.actual_cost(), 6),
    });
  }

  /**
   * Never trust LLM arithmetic: clamp knobs, recompute cost with the
   * cost model, and greedily repair anything that does not fit.
   */
  validate_plan(plan: ReviewPlan, source = 'planner'): ReviewPlan {
    let knobs = knobsCopy(plan.knobs, {
      max_claims: Math.max(
        1,
        Math.min(Math.trunc(plan.knobs.max_claims), MAX_CLAIMS_CAP),
      ),
      max_artifacts: Math.max(
        0,
        Math.min(Math.trunc(plan.knobs.max_artifacts), MAX_ARTIFACTS_CAP),
      ),
    });
    // greedy repair in reverse quality order until it fits
    if (this._cost_of(knobs) > this.budget_usd) {
      for (const update of [
        { max_artifacts: 0 },
        { per_section_lenses: false },
        { whole_paper_passes: false },
        { defense_round: false },
      ] as Partial<PlanKnobs>[]) {
        if (this._cost_of(knobs) <= this.budget_usd) break;
        knobs = knobsCopy(knobs, update);
      }
      let lo = MIN_CLAIMS;
      let hi = knobs.max_claims;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (this._cost_of(knobsCopy(knobs, { max_claims: mid })) <= this.budget_usd)
          lo = mid;
        else hi = mid - 1;
      }
      knobs.max_claims = lo;
    }
    const [control, stages] = this._estimates_for(knobs);
    return {
      ...plan,
      knobs,
      control_estimates: control,
      stage_estimates: stages,
      target_usd: pyRound(this._cost_of(knobs), 4),
      budget_usd: this.budget_usd,
      plan_version: (plan.plan_version || 0) + 1,
      based_on: this.stats.n_claims != null ? 'claims' : 'doc_stats',
      adjustments: [
        ...plan.adjustments,
        planAdjustmentNow('validated', 'clamp+recompute', source),
      ],
    };
  }

  // ---------------------------------------------------------- tracking --

  /** One booked call (Python note_record(CallRecord)). */
  note_record(rec: {
    callType: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): void {
    const ct = rec.callType || 'other';
    const n = this.done[ct] ?? 0;
    const a = 0.3; // EMA weight for the new sample
    this._emp_in[ct] =
      n === 0 ? rec.inputTokens : (1 - a) * this._emp_in[ct]! + a * rec.inputTokens;
    this._emp_out[ct] =
      n === 0 ? rec.outputTokens : (1 - a) * this._emp_out[ct]! + a * rec.outputTokens;
    this.done[ct] = n + 1;
    this._detect_spike(rec);
  }

  actual_cost(): number {
    return this.ledger.totalCost();
  }

  /** Actual spend + estimated cost of the REMAINING planned calls. */
  projected_final(knobs?: PlanKnobs): number {
    let estimates: Record<string, StageEstimate>;
    if (knobs !== undefined) {
      const [control, stages] = this._estimates_for(knobs);
      estimates = { ...control, ...stages };
    } else if (this.plan !== undefined) {
      estimates = planAllEstimates(this.plan);
    } else {
      return this.actual_cost();
    }
    let proj = this.actual_cost();
    for (const [ct, est] of Object.entries(estimates)) {
      const remaining = Math.max(0, est.calls - (this.done[ct] ?? 0));
      if (remaining) proj += remaining * this.unit_cost(ct);
    }
    return proj;
  }

  status(): Record<string, unknown> {
    const plan = this.plan;
    const by_ct: Record<string, unknown> = {};
    if (plan !== undefined) {
      for (const [ct, est] of Object.entries(planAllEstimates(plan))) {
        by_ct[ct] = {
          role: est.role,
          planned_calls: est.calls,
          done_calls: this.done[ct] ?? 0,
          planned_usd: est.est_cost_usd,
        };
      }
    }
    const actual = this.actual_cost();
    let control_actual = 0;
    for (const rec of this.ledger.calls) {
      if (CONTROL_TYPES.has(rec.callType || 'other')) control_actual += rec.costUsd;
    }
    return {
      budget_usd: pyRound(this.budget_usd, 4),
      target_usd: plan ? pyRound(plan.target_usd, 4) : null,
      planned_usd: plan ? pyRound(planPlannedCost(plan), 4) : null,
      actual_usd: pyRound(actual, 4),
      control_actual_usd: pyRound(control_actual, 4),
      projected_final_usd: pyRound(this.projected_final(), 4),
      planner_calls_used: plan ? plan.planner_calls_used : 0,
      planner_calls_max: plan ? plan.planner_calls_max : 0,
      by_call_type: by_ct,
    };
  }

  // ---------------------------------------------------------- steering --

  /**
   * Reason string when a replan is warranted, else null.
   *
   * Gated: only in auto mode, and only on material deviation — the
   * replan COUNT is deliberately unbounded (project-owner decision);
   * anti-thrash comes from the deviation thresholds and the fact that
   * every committee call draws from the same budget.
   */
  should_replan(): string | null {
    if (!this.auto || this.plan === undefined) return null;
    const proj = this.projected_final();
    if (proj > OVERRUN_BUDGET_FRACTION * this.budget_usd) {
      return 'projected overrun of the budget';
    }
    if (proj > (1 + TARGET_TOLERANCE) * this.plan.target_usd) {
      return 'projected spend exceeds the soft target by more than 20%';
    }
    if (this.spike_events.length > 0) {
      return 'an unexpectedly expensive call was booked (spike)';
    }
    return null;
  }

  /**
   * Pre-costed adjustments to FUTURE calls (already-spent calls stay).
   * Ordered by descending savings.
   */
  repair_options(): RepairOption[] {
    if (this.plan === undefined) return [];
    const cur = this.plan.knobs;
    const base_proj = this.projected_final();
    const candidates: [string, string, string, PlanKnobs][] = [];
    const est_claims = knownOrEstimatedClaims(this.stats);
    candidates.push([
      'drop_artifacts',
      'Stop figure/table artifact checks',
      'Cheap to re-run later; findings are usually peripheral',
      knobsCopy(cur, { max_artifacts: 0 }),
    ]);
    candidates.push([
      'drop_lenses',
      'Skip the per-section lens grid',
      'Loses breadth (per-section prose/math/stats reading)',
      knobsCopy(cur, { per_section_lenses: false }),
    ]);
    candidates.push([
      'drop_whole_paper_verify',
      'Skip the whole-paper coherence pass',
      'Loses cross-section consistency findings',
      knobsCopy(cur, { whole_paper_passes: false }),
    ]);
    candidates.push([
      'drop_defense',
      'Skip the defense/adjudication gate',
      'Keeps more unverified comments; report notes this',
      knobsCopy(cur, { defense_round: false }),
    ]);
    for (const [frac, name] of [
      [0.7, 'trim_claims_30'],
      [0.5, 'trim_claims_50'],
    ] as [number, string][]) {
      const new_n = Math.max(
        MIN_CLAIMS,
        Math.min(cur.max_claims, Math.trunc(est_claims * frac)),
      );
      if (new_n < cur.max_claims) {
        candidates.push([
          name,
          `Trim claim verification to ~${new_n} claims`,
          'Claims are importance-sorted; peripheral ones go first',
          knobsCopy(cur, { max_claims: new_n }),
        ]);
      }
    }
    const out: RepairOption[] = [];
    let i = 0;
    for (const [action, label, impact, knobs] of candidates) {
      const saves = base_proj - this.projected_final(knobs);
      if (saves > 1e-9) {
        out.push({
          index: i,
          action,
          label,
          saves_usd: pyRound(saves, 4),
          impact,
        });
      }
      i += 1;
    }
    out.sort((a, b) => b.saves_usd - a.saves_usd);
    out.forEach((o, idx) => {
      o.index = idx;
    });
    return out;
  }

  apply_option(option: RepairOption, reason: string, source = 'steering'): ReviewPlan {
    const plan = this.plan;
    if (plan === undefined) throw new Error('apply_option without a plan');
    let knobs = plan.knobs;
    const updates: Record<string, Partial<PlanKnobs>> = {
      drop_artifacts: { max_artifacts: 0 },
      drop_lenses: { per_section_lenses: false },
      drop_whole_paper_verify: { whole_paper_passes: false },
      drop_defense: { defense_round: false },
    };
    if (updates[option.action] !== undefined) {
      knobs = knobsCopy(knobs, updates[option.action]!);
    } else if (option.action.startsWith('trim_claims')) {
      const frac = option.action.includes('30') ? 0.7 : 0.5;
      knobs = knobsCopy(knobs, {
        max_claims: Math.max(
          MIN_CLAIMS,
          Math.min(
            knobs.max_claims,
            Math.trunc(knownOrEstimatedClaims(this.stats) * frac),
          ),
        ),
      });
    }
    return this.validate_plan(
      {
        ...plan,
        knobs,
        adjustments: [
          ...plan.adjustments,
          planAdjustmentNow(reason, option.action, source, option.label),
        ],
      },
      source,
    );
  }

  /**
   * Deterministic first: act without the LLM whenever the choice is
   * forced, involve the planner only for real judgment calls.
   */
  steer(): Steering {
    const reason = this.should_replan();
    if (reason === null) return new Steering('none', undefined, undefined, 'on plan');
    const proj = this.projected_final();
    if (proj <= this.budget_usd) {
      // soft-target drift only: tolerated by design
      return new Steering(
        'none',
        undefined,
        undefined,
        `within soft tolerance (${reason})`,
      );
    }
    const options = this.repair_options().filter(
      (o) => proj - o.saves_usd <= this.budget_usd,
    );
    if (options.length === 0) {
      return new Steering(
        'cant_fix',
        undefined,
        undefined,
        'no repair option closes the gap; relying on per-call gating and the cap',
      );
    }
    if (options.length === 1) {
      return new Steering('applied', options[0], options, reason);
    }
    return new Steering('needs_planner', undefined, options, reason);
  }

  // ---------------------------------------------------------- gating --

  /**
   * Fan-out gate: can we afford one more unit of this call type while
   * keeping the projection under the hard budget? Preset mode is uncapped
   * by design, so its gate is always open.
   */
  allow_call(ct: string): boolean {
    if (!this.auto || this.plan === undefined) return true;
    return this.projected_final() + this.unit_cost(ct) <= this.budget_usd;
  }

  note_gate_stop(ct: string, units_skipped: number): void {
    this.gate_stopped[ct] = (this.gate_stopped[ct] ?? 0) + units_skipped;
  }

  // ---------------------------------------------------------- briefing --

  /**
   * Structured payload for the planner LLM: everything it needs to
   * design or adjust the plan, including what its own call costs.
   * (Planner LLM itself is Stage 7e+; the payload shape ports now.)
   */
  briefing(options?: RepairOption[]): Record<string, unknown> {
    const st = this.status() as Record<string, unknown>;
    const plan = this.plan;
    return {
      mode: options !== undefined ? 'adjust' : 'initial',
      budget_usd: st['budget_usd'],
      soft_target_usd: st['target_usd'],
      spent_usd: st['actual_usd'],
      projected_final_usd: st['projected_final_usd'],
      planner_call_cost_usd: pyRound(this.unit_cost('planner'), 4),
      planner_calls_remaining: plan
        ? plan.planner_calls_max - plan.planner_calls_used
        : MAX_PLANNER_CALLS,
      document_stats: { ...this.stats },
      unit_costs_usd: Object.fromEntries(
        REVIEW_TYPES.map((ct) => [ct, pyRound(this.unit_cost(ct), 4)]),
      ),
      current_knobs: plan ? { ...plan.knobs } : null,
      call_progress: st['by_call_type'],
      repair_options: (options ?? []).map((o) => ({ ...o })),
      rules:
        'Plan honestly under budget; a simple paper should target well below it. ' +
        'Your plan is validated and repaired deterministically if it does not fit. ' +
        "Returning action='noop' when things are on track is free of regret.",
    };
  }

  // ---------------------------------------------- frontier & replanning --

  /**
   * Cost kept aside so an incomplete review can always be wrapped up
   * by a model call (strong, manuscript + findings as context).
   */
  wrapup_reserve(): number {
    if (!this.auto) return 0;
    return pyRound(this.unit_cost('wrapup'), 6);
  }

  effective_budget(): number {
    return this.budget_usd - this.wrapup_reserve();
  }

  preset_estimates(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, knobs] of Object.entries(PRESET_KNOBS)) {
      const [control, stages] = this._estimates_for(knobs);
      let sum = 0;
      for (const e of Object.values({ ...control, ...stages })) sum += e.est_cost_usd;
      out[name] = pyRound(sum, 6);
    }
    return out;
  }

  fast_floor(): number {
    return this.preset_estimates()['fast']!;
  }

  private _remaining_cost(knobs: PlanKnobs): number {
    // Cost of the calls still to be made under these knobs, given what
    // is already done (per call type).
    const [control, stages] = this._estimates_for(knobs);
    const est = { ...control, ...stages };
    let remaining = 0;
    for (const [ct, e] of Object.entries(est)) {
      const n = Math.max(0, e.calls - (this.done[ct] ?? 0));
      if (n) remaining += n * this.unit_cost(ct);
    }
    return remaining;
  }

  cheapest_completion_cost(): number {
    // Cost of the cheapest possible completion (lean-finish continuation).
    if (this.plan === undefined) return 0;
    const verified = this.done['claim_verify'] ?? 0;
    const lean = knobsCopy(this.plan.knobs, {
      max_claims: verified,
      per_section_lenses: false,
      whole_paper_passes: false,
      defense_round: false,
      max_artifacts: 0,
    });
    return this.actual_cost() + this._remaining_cost(lean);
  }

  /** Additional budget needed to complete even the cheapest continuation. */
  shortfall(): number {
    if (this.plan === undefined) return 0;
    return pyRound(
      Math.max(0, this.cheapest_completion_cost() - this.effective_budget()),
      6,
    );
  }

  note_yield(call_type: string, findings: number, max_severity = 0): void {
    const agg = (this.yield_data[call_type] ??= {
      findings: 0,
      max_severity: 0,
      units: 0,
    });
    agg.findings += findings;
    agg.max_severity = Math.max(agg.max_severity, max_severity);
    agg.units += 1;
  }

  private _detect_spike(rec: { callType: string; costUsd: number }): void {
    if (CONTROL_TYPES.has(rec.callType) || rec.callType.startsWith('dm_')) return;
    const est = this.unit_cost(rec.callType);
    if (est > 0 && rec.costUsd >= SPIKE_FACTOR * est) {
      this.spike_events.push({
        ts: new Date().toISOString(),
        call_type: rec.callType,
        estimated_unit_usd: pyRound(est, 6),
        actual_usd: pyRound(rec.costUsd, 6),
      });
    }
  }

  /** Return and clear the pending spike (checked at every checkpoint). */
  consume_spike(): Record<string, unknown> | undefined {
    return this.spike_events.at(-1);
  }

  replan_context(paths?: Record<string, unknown>[]): Record<string, unknown> {
    const st = this.status() as Record<string, unknown>;
    const plan = this.plan;
    const planned = plan
      ? Math.min(plan.knobs.max_claims, knownOrEstimatedClaims(this.stats))
      : 0;
    return {
      budget_usd: st['budget_usd'],
      target_usd: st['target_usd'],
      spent_usd: st['actual_usd'],
      projected_final_usd: st['projected_final_usd'],
      residual_budget_usd: pyRound(
        this.effective_budget() - (st['actual_usd'] as number),
        6,
      ),
      coverage: {
        claims_planned: planned,
        claims_verified: this.done['claim_verify'] ?? 0,
        claims_remaining: Math.max(0, planned - (this.done['claim_verify'] ?? 0)),
      },
      observed_yield: { ...this.yield_data },
      gate_stops: { ...this.gate_stopped },
      spikes: this.spike_events.slice(-3),
      unit_costs_usd: Object.fromEntries(
        REVIEW_TYPES.map((ct) => [ct, pyRound(this.unit_cost(ct), 6)]),
      ),
      residual_paths: paths ?? [],
      rules:
        'Choose the continuation that maximizes review value within the ' +
        'residual budget. Depth = more claims verified; breadth = more ' +
        'passes. Use observed yield: keep spending where findings emerge, ' +
        'cut where they do not.',
    };
  }

  // ------------------------------------------------- committee frontier --

  /**
   * Deterministic feasible-by-construction menu for the committee. Every
   * returned path fits the (reserve-adjusted) budget (Python frontier()).
   */
  frontier(limit = 10): FrontierPath[] {
    const cap = this.effective_budget();
    const total_claims = knownOrEstimatedClaims(this.stats);
    const out: FrontierPath[] = [];
    for (const [name, desc, knobs] of FRONTIER_ARCHETYPES) {
      const capped = Math.min(knobs.max_claims, total_claims);
      const k = knobsCopy(knobs, { max_claims: capped });
      let description = desc;
      if (
        capped < knobs.max_claims &&
        knobs.max_claims > 0 &&
        name !== 'fast-scan' &&
        name !== 'triage-plus-lenses'
      ) {
        // rename to reflect the actual claim count when capped
        description = description
          .replace('Top-50', `Top-${capped}`)
          .replace('All claims', `Top-${capped} claims`);
      }
      const cost = this._cost_of(k);
      if (cost <= cap) {
        out.push({
          name,
          description,
          knobs: k,
          est_cost_usd: pyRound(cost, 6),
          claims_count: k.max_claims,
          passes: passesOf(k),
        });
      }
    }
    // keep diversity: sort by cost, cap the list
    out.sort((a, b) => a.est_cost_usd - b.est_cost_usd);
    if (out.length > limit) {
      // evenly spaced selection that always keeps the extremes
      const idx: number[] = [];
      for (let i = 0; i < limit; i++) {
        idx.push(Math.round((i * (out.length - 1)) / (limit - 1)));
      }
      const seen = new Set<number>();
      const picked: FrontierPath[] = [];
      for (const i of idx) {
        if (!seen.has(i)) {
          seen.add(i);
          picked.push(out[i]!);
        }
      }
      return picked;
    }
    return out;
  }

  /**
   * Commit a frontier path: feasible by construction, recomputed costs
   * (Python path_to_plan).
   */
  path_to_plan(path: FrontierPath, reason: string, rationale = ''): ReviewPlan {
    const [control, stages] = this._estimates_for(path.knobs);
    const plan: ReviewPlan = {
      plan_version: 1,
      budget_usd: this.budget_usd,
      target_usd: pyRound(path.est_cost_usd, 4),
      knobs: path.knobs,
      control_estimates: control,
      stage_estimates: stages,
      // no numeric cap on replans (project-owner decision); the counter
      // still tracks how many committee calls were spent
      planner_calls_max: 10_000,
      planner_calls_used: this.plan?.planner_calls_used ?? 0,
      rationale: rationale || `frontier path '${path.name}': ${path.description}`,
      based_on: 'frontier',
      adjustments: [
        planAdjustmentNow(
          reason,
          `frontier:${path.name}`,
          'committee',
          path.description,
        ),
      ],
    };
    this.set_plan(plan, `frontier:${path.name}`);
    return plan;
  }

  /**
   * Commit a replan continuation: knobs applied, costs recomputed by the
   * cost model (feasible by construction — built from the residual)
   * (Python apply_residual).
   */
  apply_residual(path: ResidualPath, reason: string): ReviewPlan {
    const [control, stages] = this._estimates_for(path.knobs);
    const plan: ReviewPlan = {
      plan_version: 1,
      budget_usd: this.budget_usd,
      target_usd: pyRound(this.actual_cost() + this._remaining_cost(path.knobs), 4),
      knobs: path.knobs,
      control_estimates: control,
      stage_estimates: stages,
      planner_calls_max: 10_000,
      planner_calls_used: this.plan?.planner_calls_used ?? 0,
      rationale: `continuation '${path.name}': ${path.description}`,
      based_on: 'residual-frontier',
      adjustments: [
        planAdjustmentNow(
          reason,
          `continuation:${path.name}`,
          'committee',
          path.description,
        ),
      ],
    };
    this.set_plan(plan, `continuation:${path.name}`);
    return plan;
  }

  /**
   * 4-5 continuation plans built from residual steps + residual budget.
   * Feasible by construction: actual + remaining <= budget - wrapup reserve
   * (Python residual_frontier).
   */
  residual_frontier(limit = 5): ResidualPath[] {
    if (this.plan === undefined) return [];
    const cap = this.effective_budget();
    const actual = this.actual_cost();
    const cur = this.plan.knobs;
    const verified = this.done['claim_verify'] ?? 0;
    const remaining_now = Math.max(
      0,
      Math.min(cur.max_claims, knownOrEstimatedClaims(this.stats)) - verified,
    );

    const variant = (
      name: string,
      desc: string,
      knobs: PlanKnobs,
    ): ResidualPath | null => {
      const proj = actual + this._remaining_cost(knobs);
      if (proj > cap) return null;
      const extra_claims = Math.max(
        0,
        Math.min(knobs.max_claims, knownOrEstimatedClaims(this.stats)) - verified,
      );
      const passes =
        passesOf(knobs).filter((p) => !passesOf(cur).includes(p)) ||
        // Python `or [...]` keeps the fallback when the filtered list is
        // empty — an empty array is falsy in Python, always truthy in JS,
        // so mirror the intent with an explicit check.
        [];
      return {
        name,
        description: desc,
        knobs,
        projected_final_usd: pyRound(proj, 6),
        claims_remaining: extra_claims,
        passes_remaining: passes.length > 0 ? passes : ['finish current passes'],
      };
    };

    const candidates: [string, string, PlanKnobs][] = [
      ['continue', 'Continue the current plan as-is', cur],
      [
        'trim-claims',
        `Verify ~half of the ${remaining_now} remaining claims ` +
          '(least important dropped first)',
        knobsCopy(cur, {
          max_claims: verified + Math.max(0, Math.floor(remaining_now / 2)),
        }),
      ],
      [
        'stop-claims-hold-breadth',
        'Stop new claim verification; keep the planned breadth passes',
        knobsCopy(cur, { max_claims: verified }),
      ],
      [
        'drop-defense',
        'Keep claims; skip the defense/adjudication gate',
        knobsCopy(cur, { defense_round: false }),
      ],
      [
        'lean-finish',
        'Stop claims and breadth; challenger + meta + validation only',
        knobsCopy(cur, {
          max_claims: verified,
          per_section_lenses: false,
          whole_paper_passes: false,
          defense_round: false,
          max_artifacts: 0,
          // e2ba304-era parity (7f review D2): Python residual_frontier's
          // lean-finish does NOT touch synthesis — only min_viable_knobs
          // carries synthesis:false. The essay keeps the min-viable floor.
        }),
      ],
    ];
    // quality-ordered: keep the best feasible ones
    const out: ResidualPath[] = [];
    for (const [name, desc, knobs] of candidates) {
      const v = variant(name, desc, knobs);
      if (v !== null) out.push(v);
    }
    // 'continue' first if feasible, else ordered by least cutting
    const priority: Record<string, number> = {
      continue: 0,
      'trim-claims': 1,
      'stop-claims-hold-breadth': 2,
      'drop-defense': 3,
      'lean-finish': 4,
    };
    out.sort((a, b) => (priority[a.name] ?? 9) - (priority[b.name] ?? 9));
    return out.slice(0, limit);
  }
}

// ------------------------------------------------------------------ frontier --

/** claim counts by importance rank (capped) */
export const DEPTH_LEVELS: readonly number[] = [0, 10, 25, 50, 150];

export const PRESET_KNOBS: Record<string, PlanKnobs> = {
  // cheaper and less detailed than hosted deep-review products
  fast: PlanKnobs({
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
  // "match Refine": reproduction voting on every claim, strong-model routing
  // on numerical/table claims, full lens grid, defense, all checkers + DOI
  // loop, lead-referee synthesis
  standard: PlanKnobs({
    verify_passes: 2,
    claim_routing: 'strong',
    output_budget: 'default',
  }),
  // "deeper than Refine": triple-pass verification routed to the auditor
  // when configured, all claims on the strong model, double defense, max
  // reasoning budgets
  deep: PlanKnobs({
    max_claims: 150,
    max_artifacts: 50,
    verify_passes: 3,
    claim_routing: 'all_strong',
    output_budget: 'high',
    defense_second_round: true,
  }),
};

// (name, description, knobs) — ~14 archetypes over the two axes; the frontier
// keeps the ~10 most diverse FEASIBLE ones for the committee.
export const FRONTIER_ARCHETYPES: [string, string, PlanKnobs][] = [
  [
    'fast-scan',
    'No claim verification; whole-paper coherence pass only',
    PlanKnobs({
      max_claims: 0,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: false,
      max_artifacts: 0,
    }),
  ],
  [
    'lean-core',
    'Minimal meaningful: 6 central claims, no extras',
    PlanKnobs({
      max_claims: MIN_CLAIMS,
      per_section_lenses: false,
      whole_paper_passes: false,
      defense_round: false,
      max_artifacts: 0,
    }),
  ],
  [
    'claims-light',
    'Top-10 claims + whole-paper pass',
    PlanKnobs({
      max_claims: 10,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: false,
      max_artifacts: 0,
    }),
  ],
  [
    'claims-standard',
    'Top-25 claims + whole-paper pass',
    PlanKnobs({
      max_claims: 25,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: false,
      max_artifacts: 0,
    }),
  ],
  [
    'claims-deep',
    'Top-50 claims + whole-paper pass + defense gate',
    PlanKnobs({
      max_claims: 50,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 0,
    }),
  ],
  [
    'claims-max',
    'All claims + whole-paper pass + defense gate (depth-maximal)',
    PlanKnobs({
      max_claims: 150,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 0,
    }),
  ],
  [
    'balanced',
    'Top-25 claims + lenses + whole-paper + defense + some artifacts',
    PlanKnobs({
      max_claims: 25,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 6,
    }),
  ],
  [
    'breadth-standard',
    'Top-15 claims + full breadth (lenses, whole-paper, artifacts, defense)',
    PlanKnobs({
      max_claims: 15,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 12,
    }),
  ],
  [
    'breadth-max',
    'Top-10 claims + maximal breadth passes',
    PlanKnobs({
      max_claims: 10,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 25,
    }),
  ],
  [
    'deep-plus',
    'Top-50 claims + full breadth + defense',
    PlanKnobs({
      max_claims: 50,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 12,
    }),
  ],
  [
    'cross-check',
    'Top-20 claims, each verified twice (auditor if configured), strong ' +
      'numerical routing + defense',
    PlanKnobs({
      max_claims: 20,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: true,
      verify_passes: 2,
      claim_routing: 'strong',
    }),
  ],
  [
    'deep-verify',
    'Top-30 claims, triple-pass verification (auditor cross-examination), ' +
      'all-strong routing, defense + recomputation',
    PlanKnobs({
      max_claims: 30,
      per_section_lenses: false,
      whole_paper_passes: true,
      defense_round: true,
      verify_passes: 3,
      claim_routing: 'all_strong',
    }),
  ],
  [
    'rigor-max',
    'Top-40 claims × 2 passes + full breadth + defense + recomputation',
    PlanKnobs({
      max_claims: 40,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 6,
      verify_passes: 2,
      claim_routing: 'strong',
    }),
  ],
  [
    'maximal',
    'Everything that fits: all claims, all passes',
    PlanKnobs({
      max_claims: 150,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: true,
      max_artifacts: 25,
    }),
  ],
  [
    'triage-plus-lenses',
    'No claims; lenses + whole-paper (pure breadth)',
    PlanKnobs({
      max_claims: 0,
      per_section_lenses: true,
      whole_paper_passes: true,
      defense_round: false,
      max_artifacts: 6,
    }),
  ],
];

export interface FrontierPath {
  name: string;
  description: string;
  knobs: PlanKnobs;
  est_cost_usd: number;
  /** ranked claims verified under this path */
  claims_count: number;
  /** breadth passes included */
  passes: string[];
}

export function frontierMenuLine(p: FrontierPath): string {
  return (
    `${p.name}: ${p.description} — approx $${p.est_cost_usd.toFixed(4)} ` +
    `(${p.claims_count} claims; passes: ${p.passes.join(', ') || 'none'})`
  );
}

export function passesOf(knobs: PlanKnobs): string[] {
  const passes: string[] = [];
  if (knobs.per_section_lenses) passes.push('section-lenses');
  if (knobs.whole_paper_passes) passes.push('whole-paper');
  if (knobs.max_artifacts > 0) passes.push(`artifacts≤${knobs.max_artifacts}`);
  if (knobs.defense_round) passes.push('defense-gate');
  return passes;
}

export interface ResidualPath {
  name: string;
  description: string;
  /** the plan knobs AFTER applying this continuation */
  knobs: PlanKnobs;
  /** actual + remaining under these knobs */
  projected_final_usd: number;
  /** additional claims verified if followed */
  claims_remaining: number;
  passes_remaining: string[];
}

// ------------------------------------------------------------------- helpers --

/** Python DocumentStats.known_or_estimated_claims property. */
export function knownOrEstimatedClaims(stats: DocumentStats): number {
  if (stats.n_claims != null) return stats.n_claims;
  return Math.max(10, Math.min(MAX_CLAIMS_CAP, Math.floor(stats.chars / 2500)));
}

/**
 * Python round(x, n) for small n (n=2, 4, 6 here): the same correctly-rounded
 * decimal semantics as roundPy2, generalized. The exact binary expansion of
 * the double (num * 2^exp, both exact BigInts) is compared against the
 * decimal half m/2*10^n WITHOUT any scaling in floating point, so no
 * double-rounding can occur: 2.675's double (slightly below the true half)
 * rounds DOWN exactly like CPython, and half-to-even applies only on the
 * exact tie. Parity-probed against `uv run python` round() (see
 * tests/budget.test.ts, PY_ROUNDS).
 */
export function pyRound(x: number, n: number): number {
  if (n === 2) return roundPy2(x);
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const neg = x < 0;
  const ax = Math.abs(x);
  // Exact scaled integer of the binary value: |x| = num * 2^exp.
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = ax;
  const bits = BigInt.asUintN(64, new BigUint64Array(buf)[0]!);
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  let num: bigint;
  let exp: number;
  if (rawExp === 0) {
    num = frac;
    exp = -1074;
  } else {
    num = frac | (1n << 52n);
    exp = rawExp - 1075;
  }
  // digits = 10^n; result = round_half_even(num * 2^exp * digits) / digits.
  const digits = 10n ** BigInt(n);
  let scaled: bigint;
  if (exp >= 0) {
    // exact integer: rounding is the identity
    scaled = (num << BigInt(exp)) * digits;
  } else {
    const den = 1n << BigInt(-exp);
    const dividend = num * digits;
    const q = dividend / den;
    const r = dividend % den;
    const twice = r * 2n;
    // round-half-to-even on the exact remainder
    scaled = twice > den || (twice === den && q % 2n === 1n) ? q + 1n : q;
  }
  const out = Number(scaled) / Number(digits);
  return neg ? -out : out;
}

/**
 * Adapter from the TS `UsageLedger` (providers/usage.ts) to the harness's
 * `LedgerView`. The TS ledger keys pricing by bare model name
 * (settings.pricing), Python by `${provider}/${model}` — the adapter tries
 * the full key first, then the model tail, keeping both conventions working.
 */
export function ledgerView(
  ledger: {
    calls: {
      role: string;
      usage: { promptTokens: number; completionTokens: number };
      costUsd: number;
      callType?: string;
    }[];
    totalCost(): number;
  },
  pricing: Record<string, PricingEntry>,
): LedgerView & { totalCost(): number } {
  return {
    get calls(): LedgerView['calls'] {
      // Live view: expose the ledger's records with the callType default.
      return ledger.calls.map((c) => ({
        role: c.role,
        inputTokens: c.usage.promptTokens,
        outputTokens: c.usage.completionTokens,
        costUsd: c.costUsd,
        callType: c.callType ?? 'other',
      }));
    },
    priceFor(key: string): PricingEntry | undefined {
      const tail = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
      // Missing entry = unpriced (Python pricing dict membership semantics).
      return pricing[key] ?? pricing[tail];
    },
    totalCost(): number {
      return ledger.totalCost();
    },
  };
}
