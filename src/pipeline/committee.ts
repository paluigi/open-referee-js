/**
 * Planning committee: strategy and replanning protocols on the harness
 * frontier, with decision models in the decisive seats.
 *
 * Port of Python `open_referee/pipeline/committee.py` (origin/main 26ae883),
 * adapted to the TS orchestrator's injected-dependency shape (callJson +
 * an optional Decider — see `CommitteeDeps`). Principles (agreed with the
 * project owner):
 * - the LLM (strong) REASONS — draft, self-challenge, evaluation — but has no
 *   commit authority;
 * - the decision model CHOOSES among feasible-by-construction paths and
 *   CONFIRMS; on a rejected confirmation exactly one more round runs and its
 *   choice commits unconditionally;
 * - an infeasible plan can never be committed: every choice is a frontier
 *   path costed by the harness;
 * - replans are unbounded in count (anti-thrash via thresholds + reserves)
 *   and each one rebuilds the frontier from residual steps + residual budget;
 * - when no continuation is feasible, a model wraps up the review from the
 *   accumulated context, the run is flagged incomplete with the estimated
 *   shortfall, and can be resumed later with a budget top-up.
 */

import { LLMError } from '../providers/base';
import type { DecisionQuestion } from '../providers/decisions';
import {
  answer,
  type DecisionAnswer,
  type DecisionResult,
} from '../providers/decisions';
import * as promptsCommittee from './prompts_committee';
import type { BudgetHarness, FrontierPath, ResidualPath } from './budget';
import { BudgetInfeasible } from './budget';
import { BudgetExceeded } from '../providers/usage';
import { knownOrEstimatedClaims } from './budget';

/** Thresholds (Python module constants). */
export const CONFIRM_THRESHOLD = 0.5; // DM confirmation probability above this commits
export const ESCALATION_CONFIDENCE = 0.5; // DM choice confidence below this escalates to the LLM

/**
 * Injected dependencies: the JSON-call funnel (orchestrator callJson) and
 * the optional decision caller. `decide` returning undefined models both
 * "no decision role configured" and "the decide() call failed" — every
 * consumer degrades to its labelled fallback.
 */
export interface CommitteeDeps {
  callJson: (
    role: 'strong' | 'small',
    system: string,
    user: string,
    opts?: { callType?: string; maxTokens?: number },
  ) => Promise<unknown>;
  /** None = no decision role configured (labelled fallbacks everywhere). */
  decide?: (
    input: string,
    questions: readonly DecisionQuestion[],
    callType: string,
  ) => Promise<DecisionResult | undefined>;
  harness: BudgetHarness;
  /** Emit a pipeline event (stage 'plan'-scoped in the orchestrator). */
  emit?: (message: string, detail?: Record<string, unknown>) => Promise<void>;
  /** Triage summary for the strategy reflection (Python _triage_cache). */
  triage?: Record<string, unknown>;
  /** Sync the harness plan to the persisted run state (Python _sync_budget_to_state). */
  syncBudgetToState?: () => void;
}

// ------------------------------------------------------------- claim ranking --

/**
 * Total importance order over claims. Decision-model rubric when
 * configured; the inventory's coarse importance is the fallback order
 * (Python rank_claims).
 */
export async function rankClaims(
  deps: CommitteeDeps,
  claims: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (claims.length === 0) return claims;
  const fallbackOrder = (): Record<string, unknown>[] => {
    const order: Record<string, number> = { central: 0, supporting: 1, peripheral: 2 };
    return [...claims].sort(
      (a, b) =>
        (order[String(a['importance']).toLowerCase()] ?? 1) -
        (order[String(b['importance']).toLowerCase()] ?? 1),
    );
  };
  if (deps.decide === undefined) return fallbackOrder();

  const lines = claims.map((c, i) => {
    const comps = JSON.stringify(c['components'] ?? {}).slice(0, 220);
    return (
      `${i + 1}. [${c['id']}] type=${c['type']} importance=${c['importance']} ` +
      `anchor=${String(c['anchor'] ?? '').slice(0, 100)} components=${comps}`
    );
  });
  const questions: DecisionQuestion[] = claims.map((c, i) => ({
    type: 'score',
    name: `claim_${c['id'] ?? i}`,
    instructions:
      `Review value of verifying claim ${i + 1} (${c['type']}) with an isolated ` +
      'verification call: how much would a finding here change the review verdict?',
    levels: [
      { label: 'low', description: 'peripheral or mechanical' },
      { label: 'medium', description: 'supporting evidence' },
      { label: 'high', description: 'material to the main results' },
      { label: 'critical', description: "central to the paper's validity" },
    ],
  }));
  let result: DecisionResult;
  try {
    const r = await deps.decide(
      'Claims proposed for verification:\n' + lines.join('\n'),
      questions,
      'dm_rank',
    );
    if (r === undefined) return fallbackOrder();
    result = r;
  } catch {
    return fallbackOrder();
  }

  const rankScore: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  const labels = ['low', 'medium', 'high', 'critical'];
  const scored = claims.map((c) => {
    const a = answer(result, `claim_${c['id']}`);
    let score = 0;
    if (a?.score !== undefined) {
      const idx = Math.min(Math.round(a.score), 3);
      score = rankScore[labels[idx] ?? 'low'] ?? 0;
    }
    return {
      score,
      notCentral: String(c['importance']).toLowerCase() !== 'central',
      claim: c,
    };
  });
  scored.sort(
    (x, y) => y.score - x.score || Number(x.notCentral) - Number(y.notCentral),
  );
  const ranked = scored.map((s) => s.claim);
  await deps.emit?.(`claims ranked by decision model: top=${ranked[0]?.['id'] ?? '-'}`);
  return ranked;
}

// -------------------------------------------------------- strategy committee --

/** Python `_top_claims`: the first n claims in a numbered listing. */
function topClaims(claims: Record<string, unknown>[], n: number): string {
  if (claims.length === 0) return '(none)';
  return claims
    .slice(0, n)
    .map(
      (c, i) =>
        `${i + 1}. [${c['id']}] ${c['type']} (${c['importance']}): ` +
        `${String(c['anchor'] ?? '').slice(0, 90)}`,
    )
    .join('\n');
}

/**
 * LLM reflects → DM chooses a frontier path → DM confirms → (on
 * rejection) one more DM round commits unconditionally
 * (Python strategy_committee). Committing is the caller's job only in
 * Python; here the harness commit happens inside (harness.path_to_plan),
 * matching Python where strategy_committee performs it.
 */
export async function strategyCommittee(
  deps: CommitteeDeps,
  claims: Record<string, unknown>[],
): Promise<{ reflection: Record<string, string>; path: FrontierPath; plan: unknown }> {
  const harness = deps.harness;
  const frontier = harness.frontier(10);
  if (frontier.length === 0) {
    // Python raises BudgetInfeasible with the fast floor + standard estimate.
    const est = harness.preset_estimates();
    throw new BudgetInfeasible(
      'No feasible frontier path fits the budget for this paper.',
      Math.round(harness.fast_floor() * 10_000) / 10_000,
      Math.round((est['standard'] ?? 0) * 10_000) / 10_000,
    );
  }
  const menu = frontier.map((p) => frontierMenuLine(p)).join('\n');

  // 1. LLM reflects (strong; no commit authority)
  let reflection: Record<string, unknown> = {};
  try {
    const reflectUser = promptsCommittee.strategyReflectUser({
      statsJson: stableStringifyIndented(harness.stats),
      triage: sliceJson(deps.triage ?? {}, 2500),
      topClaims: topClaims(claims, 12),
      frontierMenu: menu,
      budget: harness.budget_usd,
    });
    const res = (await deps.callJson(
      'strong',
      promptsCommittee.STRATEGY_REFLECT_SYSTEM,
      reflectUser,
      { callType: 'planner' },
    )) as { kind: string; value?: unknown; error?: LLMError };
    if (res.kind === 'budget') {
      // Python complete_json lets BudgetExceeded propagate (only LLMError is
      // caught in the best-effort reflection) — rethrow instead of degrading
      // (7e review B7).
      throw res.error;
    }
    if (res.kind === 'ok' && typeof res.value === 'object' && res.value !== null) {
      reflection = res.value as Record<string, unknown>;
      if (harness.plan !== undefined) harness.plan.planner_calls_used += 1;
    }
  } catch (err) {
    // reflection is best-effort (budget errors propagate)
    if (err instanceof BudgetExceeded) throw err;
  }

  const summary = {
    draft: String(reflection['draft'] ?? '').slice(0, 1500),
    critique: String(reflection['critique'] ?? '').slice(0, 1500),
    evaluation: String(reflection['evaluation_summary'] ?? '').slice(0, 1500),
    preferred: String(reflection['preferred_path'] ?? '').slice(0, 80),
  };

  let chosen: FrontierPath | undefined;
  if (deps.decide !== undefined) {
    // 2. DM chooses among the frontier paths
    chosen = await dmChoosePath(deps, frontier, summary, 'initial strategy');
    // 3. DM confirms
    if (chosen !== undefined) {
      const confirm = await dmConfirm(deps, chosen, summary);
      if (confirm !== undefined && confirm < CONFIRM_THRESHOLD && frontier.length > 1) {
        // 4. rejected: one more round over all paths; commits as-is
        const second = await dmChoosePath(
          deps,
          frontier,
          summary,
          'rejection round',
          `The first choice (${chosen.name}) was rejected by confirmation ` +
            `(probability ${confirm.toFixed(2)}). Choose again over ALL paths.`,
        );
        if (second !== undefined) chosen = second;
      }
    }
  }
  if (chosen === undefined) {
    // fallback: LLM's preferred path, else deterministic greedy pick
    const pref = summary['preferred'];
    chosen = frontier.find((p) => p.name === pref) ?? frontier[frontier.length - 1]!;
  }

  const plan = harness.path_to_plan(
    chosen,
    'strategy-committee',
    (summary['evaluation'] || '').slice(0, 500) || chosen.description,
  );
  await deps.emit?.(
    `committee committed frontier path '${chosen.name}' ` +
      `(~$${chosen.est_cost_usd.toFixed(4)}, ${chosen.claims_count} claims)`,
    {
      plan: JSON.parse(JSON.stringify(plan)),
      budget: harness.status(),
      committee: { reflection: summary, path: chosen.name },
    },
  );
  deps.syncBudgetToState?.();
  return { reflection: summary, path: chosen, plan };
}

function frontierMenuLine(p: FrontierPath): string {
  return (
    `${p.name}: ${p.description} — approx $${p.est_cost_usd.toFixed(4)} ` +
    `(${p.claims_count} claims; passes: ${p.passes.join(', ') || 'none'})`
  );
}

/** Python json.dumps(v, indent=1) — closest JS is stringify(v, null, 1). */
function stableStringifyIndented(v: unknown): string {
  return JSON.stringify(v, null, 1);
}

function sliceJson(v: unknown, cap: number): string {
  return JSON.stringify(v, null, 1).slice(0, cap);
}

async function dmChoosePath(
  deps: CommitteeDeps,
  frontier: FrontierPath[],
  summary: Record<string, string>,
  contextNote: string,
  extra = '',
): Promise<FrontierPath | undefined> {
  if (deps.decide === undefined) return undefined;
  const harness = deps.harness;
  const briefing = {
    context: contextNote,
    llm_reflection: summary,
    frontier: frontier,
    budget_usd: harness.budget_usd,
    spent_usd: harness.actual_cost(),
  };
  const q: DecisionQuestion = {
    type: 'choice',
    name: 'path_choice',
    instructions:
      "Choose the review plan for this paper given the strategist's reflection. " +
      'Depth = claims verified individually; breadth = passes over the whole paper. ' +
      "Weigh the reflection's evaluation.",
    choices: frontier.map((p) => ({
      value: p.name,
      description: `~$${p.est_cost_usd.toFixed(4)}; ${p.description}`,
    })),
  };
  let result: DecisionResult | undefined;
  try {
    result = await deps.decide(
      stableStringifyIndented(briefing).slice(0, 24_000) + extra,
      [q],
      'dm_steer',
    );
  } catch {
    return undefined;
  }
  if (result === undefined) return undefined;
  const a = answer(result, 'path_choice');
  if (a === undefined || a.choice === undefined) return undefined;
  return frontier.find((p) => p.name === a.choice);
}

async function dmConfirm(
  deps: CommitteeDeps,
  path: FrontierPath,
  summary: Record<string, string>,
): Promise<number | undefined> {
  if (deps.decide === undefined) return undefined;
  const q: DecisionQuestion = {
    type: 'predicate',
    name: 'confirm_path',
    instructions:
      `Given the strategist's evaluation, '${path.name}' ` +
      `(${path.description}, approx $${path.est_cost_usd.toFixed(4)}) is the right review ` +
      'plan for this paper and budget.',
  };
  let result: DecisionResult | undefined;
  try {
    result = await deps.decide(
      stableStringifyIndented({ reflection: summary, path }).slice(0, 12_000),
      [q],
      'dm_confirm',
    );
  } catch {
    return undefined;
  }
  if (result === undefined) return undefined;
  const a = answer(result, 'confirm_path');
  return a?.probability;
}

// --------------------------------------------------------- replan committee --

/**
 * Rebuild the residual frontier and pick a continuation. Returns true if
 * a continuation was applied, false when NOTHING is feasible (caller must
 * wrap up). Deterministic-first: a single option applies without any call
 * (Python replan_choice).
 */
export async function replanChoice(
  deps: CommitteeDeps,
  reason: string,
): Promise<boolean> {
  const harness = deps.harness;
  if (harness.plan === undefined) return true;
  const paths = harness.residual_frontier(5);
  if (paths.length === 0) return false;
  if (paths.length === 1) {
    // Python passes reason=f"steering:{path.name}" — the injected reason is
    // carried in the apply_residual action trail via the plan adjustment.
    const plan = harness.apply_residual(
      paths[0]!,
      reason || `steering:${paths[0]!.name}`,
    );
    await announce(deps, paths[0]!, plan, 'steering');
    return true;
  }

  // multi-option: decision model over the mechanical context snapshot
  const ctx = harness.replan_context(paths as unknown as Record<string, unknown>[]);
  let chosen: ResidualPath | undefined;
  if (deps.decide !== undefined) {
    const q: DecisionQuestion = {
      type: 'choice',
      name: 'continuation',
      instructions:
        'The review is over budget. Choose the continuation that maximizes review ' +
        'value within the residual budget. Depth = more claims verified; breadth = ' +
        'more passes. Use observed yield: keep spending where findings emerge.',
      choices: paths.map((p) => ({
        value: p.name,
        description: `$${p.projected_final_usd.toFixed(4)} final; ${p.description}`,
      })),
    };
    try {
      const result = await deps.decide(
        stableStringifyIndented(ctx).slice(0, 24_000),
        [q],
        'dm_steer',
      );
      if (result !== undefined) {
        const a = answer(result, 'continuation');
        if (a !== undefined && a.choice !== undefined) {
          const conf = a.confidence ?? 0.0;
          const picked = paths.find((p) => p.name === a.choice);
          if (picked !== undefined && conf >= ESCALATION_CONFIDENCE) {
            chosen = picked;
          }
        }
      }
    } catch {
      // DM continuation choice failed: escalate below
    }
  }

  if (chosen === undefined) {
    // escalation (or no decider): one reflective strong-model consultation
    chosen = await llmConsultation(deps, paths, ctx);
  }

  if (chosen === undefined) {
    chosen = paths[paths.length - 1]!; // leanest continuation as the safe default
  }
  const plan = harness.apply_residual(chosen, `replan:${chosen.name}`);
  await announce(deps, chosen, plan, 'committee');
  return true;
}

async function llmConsultation(
  deps: CommitteeDeps,
  paths: ResidualPath[],
  ctx: Record<string, unknown>,
): Promise<ResidualPath | undefined> {
  try {
    const res = (await deps.callJson(
      'strong',
      promptsCommittee.REPLAN_CONSULT_SYSTEM,
      promptsCommittee.replanConsultUser(ctx, paths),
      { callType: 'planner' },
    )) as { kind: string; value?: unknown };
    // Python counts the consultation against the planner-call budget in a
    // finally clause — even a failed consult costs its call.
    const plan = deps.harness.plan;
    if (plan !== undefined) plan.planner_calls_used += 1;
    if (res.kind !== 'ok') return undefined;
    const parsed = res.value;
    const name = String(
      (typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['continuation']
        : '') ?? '',
    );
    return paths.find((p) => p.name === name);
  } catch {
    return undefined;
  }
}

async function announce(
  deps: CommitteeDeps,
  path: ResidualPath,
  plan: unknown,
  appliedBy: string,
): Promise<void> {
  await deps.emit?.(`replan (${appliedBy}): ${path.name} — ${path.description}`, {
    plan: JSON.parse(JSON.stringify(plan)),
    budget: deps.harness.status(),
  });
  deps.syncBudgetToState?.();
}

// ------------------------------------------------------------------ wrap-up --

/** Result of wrapupIncomplete: the best-possible report for an incomplete
 * review (nothing further is feasible within the budget). */
export class ReviewIncomplete extends Error {
  readonly report: unknown;
  readonly cause_: string;
  readonly shortfall_usd: number;

  constructor(report: unknown, cause: string, shortfallUsd: number) {
    super(`review incomplete: ${cause} (+$${shortfallUsd.toFixed(2)} needed)`);
    this.name = 'ReviewIncomplete';
    this.report = report;
    this.cause_ = cause;
    this.shortfall_usd = shortfallUsd;
  }
}

/**
 * No feasible continuation: synthesize the best possible report from the
 * accumulated context, flag the run incomplete with the estimated shortfall,
 * and return ReviewIncomplete so run() can finish cleanly
 * (Python wrapup_incomplete).
 */
export async function wrapupIncomplete(
  deps: CommitteeDeps & {
    /** Assemble a report dict into the final report object (pipeline _assemble). */
    assemble?: (draft: Record<string, unknown>) => Promise<unknown>;
    manuscriptTitle?: string;
    manuscriptText?: string;
    candidates?: unknown[];
    stagesDone?: Record<string, string>;
  },
  cause: string,
): Promise<ReviewIncomplete> {
  const harness = deps.harness;
  const shortfall = harness.shortfall();
  const cheapest = harness.cheapest_completion_cost();
  await deps.emit?.(
    `no feasible continuation (${cause}); wrapping up — est. +$${shortfall.toFixed(2)} ` +
      `needed (cheapest completion ≈ $${cheapest.toFixed(2)})`,
  );
  let draft: Record<string, unknown> = {};
  try {
    const verified = harness.done['claim_verify'] ?? 0;
    const coverage: Record<string, unknown> = {
      claims_verified: verified,
      gate_stops: harness.gate_stopped,
      stages_done: deps.stagesDone ?? {},
    };
    if (harness.plan !== undefined) {
      coverage['claims_planned'] = Math.min(
        harness.plan.knobs.max_claims,
        knownOrEstimatedClaims(harness.stats),
      );
    }
    const progress = { ...harness.status(), coverage };
    const res = (await deps.callJson(
      'strong',
      promptsCommittee.WRAPUP_SYSTEM,
      promptsCommittee.wrapupUser({
        title: deps.manuscriptTitle ?? '?',
        manuscript: (deps.manuscriptText ?? '(unavailable)').slice(0, 60_000),
        progress: stableStringifyIndented(progress).slice(0, 4000),
        comments: stableStringifyIndented(deps.candidates ?? []).slice(0, 40_000),
      }),
      { callType: 'wrapup' },
    )) as { kind: string; value?: unknown };
    if (res.kind === 'ok' && typeof res.value === 'object' && res.value !== null) {
      draft = res.value as Record<string, unknown>;
    }
    if (harness.plan !== undefined) harness.plan.planner_calls_used += 1;
  } catch {
    draft = {};
  }
  draft['paper_summary'] ??= '';
  draft['overall_feedback'] ??= '';
  draft['comments'] ??= [];
  draft['validator_notes'] ??=
    `INCOMPLETE REVIEW — ${cause}. Estimated additional budget to finish: ` +
    `$${shortfall.toFixed(2)}. Resume this run with a larger budget to continue from ` +
    `where it stopped (completed stages are reused).`;
  if (deps.assemble !== undefined) {
    const report = await deps.assemble(draft);
    return new ReviewIncomplete(report, cause, shortfall);
  }
  // Python raises BudgetExceeded(shortfall or 1.0, budget) when there is no
  // doc to assemble from — modeled by returning the incomplete marker with a
  // null report; the orchestrator maps it to its own drain path.
  return new ReviewIncomplete(undefined, cause, shortfall || 1.0);
}

// Silence the unused-import lint for DecisionAnswer (re-exported for tests).
export type { DecisionAnswer };
