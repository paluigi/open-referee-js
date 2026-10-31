/**
 * Claim-based verification engine: inventory -> per-claim workers ->
 * defense-adjudication.
 *
 * Port of Python `open_referee/pipeline/claims.py`. Deviations (scoped):
 * - artifact vision passes are deferred until ChatMessage.images + adapter
 *   support (Stage 5+): `verifyArtifacts` is a stub returning []; the pure
 *   helpers that feed it (`findMentions`, `nearPageBlocks`) are ported and
 *   tested so the vision stage can build on them.
 * - RolePool JSON-repair retry is `callJsonWithRepair` here: it wraps the
 *   orchestrator's `callJson` (signature untouched) and replays with the
 *   Python repair suffix on a JSON parse failure.
 */

import type { AppSettings, ReviewDepth } from '../config/schema';
import type { Document } from '../ingestion/document';
import { buildDefinitionsPack } from '../ingestion/artifacts';
import { normalizeText } from '../ingestion/document';
import type { ReviewComment } from '../report/models';
import type { DecisionQuestion, DecisionResult } from '../providers/decisions';
import { answer } from '../providers/decisions';
import type { CallResult, DecisionCaller, StageProgress } from './orchestrator';
import { DM_BATCH_COMMENTS } from './budget';
import * as promptsClaims from './prompts_claims';
import { mapPool, type PoolResult } from './pool';
import type { Stage, StageEvent } from './state';
import { BudgetExceeded } from '../providers/usage';

export const MAX_MANUSCRIPT_CHARS = 120_000;

/** CallJson shape shared with the orchestrator (for repair + deps injection). */
export type CallJson = (
  role: 'strong' | 'small',
  system: string,
  user: string,
  opts?: { callType?: string; maxTokens?: number },
) => Promise<CallResult>;

/** The claim types the inventory may emit, mapped to the worker role. */
export const CLAIM_TYPE_ROLES: Record<string, 'strong' | 'small'> = {
  // strong model re-derives math; small handles mechanical checks
  theorem_proof: 'strong',
  equation: 'strong',
  logical: 'strong',
  assumption_use: 'strong',
  numerical: 'small',
  table_text: 'small',
  figure_text: 'small',
  citation_claim: 'small',
  cross_reference: 'small',
};

/** Python DepthPreset('standard') defaults; every consumer uses ??. */
export function depthPreset(review?: ReviewDepth): Required<ReviewDepth> {
  return {
    maxClaims: review?.maxClaims ?? 60,
    perSectionLenses: review?.perSectionLenses ?? true,
    wholePaperPasses: review?.wholePaperPasses ?? true,
    defenseRound: review?.defenseRound ?? true,
    maxArtifacts: review?.maxArtifacts ?? 12,
    maxParallelCalls: review?.maxParallelCalls ?? 8,
    recompute: review?.recompute ?? true,
    verifyPasses: review?.verifyPasses ?? 2,
    claimRouting: review?.claimRouting ?? 'strong',
    outputBudget: review?.outputBudget ?? 'default',
    synthesis: review?.synthesis ?? true,
    copyedit: review?.copyedit ?? true,
    defenseSecondRound: review?.defenseSecondRound ?? false,
  };
}

/**
 * Tier defaults from the budget tier (Stage 7c, Python ReviewConfig
 * .depth_preset()): the user's explicit `review` overrides win per field —
 * tier fills only what the user left unset. 'auto' has no fixed preset
 * (Python raises; here the deterministic planner sets the knobs) so the
 * standard defaults apply until the plan exists.
 */
export function depthPresetFromTier(settings: AppSettings): Required<ReviewDepth> {
  const tier = settings.budget?.depth?.toLowerCase().trim() ?? 'standard';
  const user = settings.review;
  const tierDefaults: ReviewDepth =
    tier === 'fast'
      ? {
          maxClaims: 20,
          perSectionLenses: false,
          wholePaperPasses: true,
          defenseRound: false,
          maxArtifacts: 6,
          recompute: false,
          verifyPasses: 1,
          claimRouting: 'base',
          outputBudget: 'low',
        }
      : tier === 'deep'
        ? {
            maxClaims: 150,
            perSectionLenses: true,
            wholePaperPasses: true,
            defenseRound: true,
            maxArtifacts: 50,
            recompute: true,
            verifyPasses: 3,
            claimRouting: 'all_strong',
            outputBudget: 'high',
            defenseSecondRound: true,
          }
        : {
            // 'standard' (and 'auto' pre-plan)
            maxClaims: 60,
            perSectionLenses: true,
            wholePaperPasses: true,
            defenseRound: true,
            maxArtifacts: 12,
            recompute: true,
            verifyPasses: 2,
            claimRouting: 'strong',
            outputBudget: 'default',
          };
  return {
    maxClaims: user?.maxClaims ?? tierDefaults.maxClaims!,
    perSectionLenses: user?.perSectionLenses ?? tierDefaults.perSectionLenses!,
    wholePaperPasses: user?.wholePaperPasses ?? tierDefaults.wholePaperPasses!,
    defenseRound: user?.defenseRound ?? tierDefaults.defenseRound!,
    maxArtifacts: user?.maxArtifacts ?? tierDefaults.maxArtifacts!,
    maxParallelCalls: user?.maxParallelCalls ?? 8,
    recompute: user?.recompute ?? tierDefaults.recompute!,
    verifyPasses: user?.verifyPasses ?? tierDefaults.verifyPasses!,
    claimRouting: user?.claimRouting ?? tierDefaults.claimRouting!,
    outputBudget: user?.outputBudget ?? tierDefaults.outputBudget!,
    synthesis: user?.synthesis ?? true,
    copyedit: user?.copyedit ?? true,
    defenseSecondRound: user?.defenseSecondRound ?? tierDefaults.defenseSecondRound!,
  };
}

/**
 * JSON-repair retry (Python RolePool.complete_json): since Stage 7d the
 * orchestrator's `callJson` carries the full Python ladder itself — parse
 * attempt, reasoning escalation (empty content + supportsReasoning), one
 * repair replay, LLMError when everything fails (c628796). This wrapper
 * therefore just forwards; the distinct `kind: 'invalid_json'` outcome no
 * longer occurs (it became an LLMError). Kept for the injected-callJson
 * signature used across the stage modules (call sites + tests untouched).
 */
export async function callJsonWithRepair(
  callJson: CallJson,
  role: 'strong' | 'small',
  system: string,
  user: string,
  callType?: string,
): Promise<CallResult> {
  return callJson(
    role,
    system,
    user,
    callType !== undefined ? { callType } : undefined,
  );
}

export interface ClaimProgress {
  (e: StageEvent, progress?: StageProgress): void;
}

export interface EmitFn {
  (
    stage: Stage,
    status: StageEvent['status'],
    detail?: string,
    progress?: StageProgress,
  ): Promise<void>;
}

/**
 * CLAIMS stage: exhaustive atomic claim catalogue for the manuscript.
 * Sanitation: claims without `components` are dropped; id/type/importance
 * get Python-parity defaults. A tripped budget cap is surfaced to the
 * caller (Python lets it propagate to the drain handler).
 */
export async function runClaimInventory(init: {
  callJson: CallJson;
  doc: Document;
  triage: Record<string, unknown>;
  settings: AppSettings;
}): Promise<{ claims: Record<string, unknown>[]; budget?: BudgetExceeded }> {
  const { callJson, doc, triage } = init;
  const user = promptsClaims.claimInventoryPrompt(
    doc.title,
    JSON.stringify(triage).slice(0, 3000),
    doc.fullText().slice(0, MAX_MANUSCRIPT_CHARS),
  );
  const res = await callJsonWithRepair(
    callJson,
    'strong',
    promptsClaims.CLAIM_INVENTORY_SYSTEM,
    user,
    'claim_inventory',
  );
  if (res.kind === 'budget') return { claims: [], budget: res.error };
  if (res.kind !== 'ok') return { claims: [] };
  const claimsRaw = (res.value as { claims?: unknown } | null)?.['claims'];
  if (!Array.isArray(claimsRaw)) return { claims: [] };
  // basic sanitation (Python: enumerate index drives default ids, so
  // dropped claims still consume a number; `{}` components is falsy there)
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < claimsRaw.length; i++) {
    const c = claimsRaw[i];
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    const comps = o['components'];
    if (
      comps === undefined ||
      comps === null ||
      typeof comps !== 'object' ||
      Object.keys(comps as object).length === 0
    ) {
      continue;
    }
    if (o['id'] === undefined) o['id'] = `cl${String(i + 1).padStart(3, '0')}`;
    if (o['type'] === undefined) o['type'] = 'logical';
    if (o['importance'] === undefined) o['importance'] = 'supporting';
    out.push(o);
  }
  return { claims: out };
}

/**
 * Per-claim verification workers, parallel under the depth-preset cap.
 * Central claims first, then supporting; peripheral only if budget remains.
 * Returns the comments plus a tripped budget error, if any (Python's gather
 * lets every queued task hit the cap individually; completed claims keep
 * their comments — the drain mirrors that).
 */
export async function verifyClaims(init: {
  callJson: CallJson;
  doc: Document;
  claims: Record<string, unknown>[];
  settings: AppSettings;
  /** Resolved plan-knob claim cap (Python knobs.max_claims); preset fallback. */
  maxClaims?: number;
  /**
   * Python `_claims_ranked` (7e review B2): when the committee's decision
   * model already ranked the claims, the given order is authoritative — the
   * coarse importance sort is skipped (Python verify_claims).
   */
  claimsRanked?: boolean;
  onEvent?: ClaimProgress;
  /** A worker failing (LLMError/invalid JSON even after repair) marks the verify stage partial. */
  onWorkerError?: () => void;
}): Promise<{ comments: ReviewComment[]; budget?: BudgetExceeded }> {
  const { callJson, doc, claims, settings, onEvent, onWorkerError } = init;
  const preset = depthPreset(settings.review);
  // Python verify_claims: ranked order is authoritative; otherwise the
  // inventory's coarse importance sorts the queue (central first).
  const ordered = init.claimsRanked
    ? [...claims]
    : (() => {
        const order: Record<string, number> = {
          central: 0,
          supporting: 1,
          peripheral: 2,
        };
        return [...claims].sort(
          (a, b) =>
            (order[String(a['importance']).toLowerCase()] ?? 1) -
            (order[String(b['importance']).toLowerCase()] ?? 1),
        );
      })();
  // Python: selected = ordered[: knobs.max_claims] — the resolved plan knob
  // (deterministic plan in auto mode), not the raw user depth preset.
  const maxClaims = init.maxClaims ?? preset.maxClaims;
  const selected = ordered.slice(0, maxClaims);

  const results = await mapPool(selected, preset.maxParallelCalls, async (claim) => {
    const ctype = String(claim['type']).toLowerCase();
    const role = CLAIM_TYPE_ROLES[ctype] ?? 'small';
    const system = promptsClaims.claimVerifySystem(ctype);
    const components = JSON.stringify(claim['components'] ?? {}, null, 1).slice(
      0,
      12_000,
    );
    const defs = definitionsFor(doc, claim);
    const user = promptsClaims.claimVerifyUser({
      claimId: String(claim['id'] ?? ''),
      claimType: ctype,
      importance: String(claim['importance'] ?? ''),
      section: String(claim['section'] ?? ''),
      components,
      definitions: defs.slice(0, 6000),
    });
    const res = await callJsonWithRepair(callJson, role, system, user, 'claim_verify');
    if (res.kind !== 'ok' && res.kind !== 'budget') onWorkerError?.();
    let comments: ReviewComment[] = [];
    if (res.kind === 'ok') {
      const raw = (res.value as { comments?: unknown } | null)?.['comments'];
      if (Array.isArray(raw)) {
        // 61f5822: all list items coming from model JSON are filtered to
        // dicts before use (Python drops non-dicts; so do we).
        comments = raw
          .filter(
            (c): c is Record<string, unknown> =>
              typeof c === 'object' && c !== null && !Array.isArray(c),
          )
          .map((c) => normalizeComment(c, claim));
      }
      onEvent?.(
        { stage: 'verify', status: 'running', at: new Date().toISOString() },
        undefined,
      );
    }
    // progress: per-claim unitsDone/unitsTotal is reported by the caller
    // (it owns the counter across the pool).
    return { comments, budget: res.kind === 'budget' ? res.error : undefined };
  });

  const out: ReviewComment[] = [];
  let budget: BudgetExceeded | undefined;
  for (const r of results) {
    if (r.ok) {
      out.push(...r.value.comments);
      budget = budget ?? r.value.budget;
    }
  }
  return { comments: out, budget };
}

/** Pull a comment object out of a worker response, adding Python-parity
 * provenance (paragraph_anchor default, claim_id). Non-dicts are skipped. */
function normalizeComment(raw: unknown, claim: Record<string, unknown>): ReviewComment {
  const o =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const severity =
    typeof o['score'] === 'number' ? Math.min(1, Math.max(0, o['score'])) : 0.3;
  return {
    section:
      typeof o['section'] === 'string' ? o['section'] : String(claim['section'] ?? ''),
    quote: typeof o['quote'] === 'string' ? o['quote'] : '',
    comment: typeof o['message'] === 'string' ? o['message'] : '',
    severity,
    paragraphAnchor:
      typeof o['paragraph_anchor'] === 'string'
        ? o['paragraph_anchor']
        : String(claim['anchor'] ?? ''),
    claimId: typeof claim['id'] === 'string' ? claim['id'] : undefined,
    category: typeof o['category'] === 'string' ? o['category'] : undefined,
    // COMMENT_SCHEMA demands a title in every response; keep it (7b renders
    // the header from it). Assemble still applies the Python fallback.
    title: typeof o['title'] === 'string' ? o['title'] : undefined,
  };
}

/**
 * Definitions pack: match the claim's anchor to a theorem environment when
 * possible; otherwise a light global pack.
 */
export function definitionsFor(doc: Document, claim: Record<string, unknown>): string {
  const anchor = String(claim['anchor'] ?? '').toLowerCase();
  for (const env of doc.theorems) {
    if (!env.statementBlockId || !anchor) continue;
    const stmt = normalizeText(env.statement).toLowerCase();
    // Python: _norm(stmt)[:80] in _norm(anchor) or _norm(anchor)[:80] in _norm(stmt)
    if (normContains(anchor, stmt) || normContains(stmt, anchor)) {
      return buildDefinitionsPack(doc, env);
    }
  }
  return lightGlobalPack(doc);
}

/** Python `_norm(a)[:80] in _norm(b)`: normalized containment on the first 80 chars. */
function normContains(haystack: string, needle: string): boolean {
  const n = needle.slice(0, 80);
  if (!n) return false;
  return haystack.includes(n);
}

export function lightGlobalPack(doc: Document): string {
  const parts: string[] = [];
  for (const env of doc.theorems) {
    if ((env.kind === 'definition' || env.kind === 'assumption') && parts.length < 12) {
      parts.push(`[${env.label ?? env.kind}] ${env.statement.slice(0, 300)}`);
    }
  }
  if (parts.length === 0) return '(no formal definitions extracted)';
  return parts.join('\n\n');
}

// ------------------------------------------------------ artifact verification --

const ARTIFACT_RE: Record<string, RegExp> = {
  figure: /\b(figure|fig\.)\s*([0-9]+)/i,
  table: /\b(table|tab\.)\s*([0-9]+)/i,
};

/**
 * Blocks whose text mentions this figure/table. For PDF artifacts with a
 * page number, also include blocks from the same page. Bounded to 12 hits.
 */
export function findMentions(
  doc: Document,
  kind: string,
  artifactId: string,
): string[] {
  const pat = ARTIFACT_RE[kind];
  const num = /([0-9]+)/.exec(artifactId);
  const out: string[] = [];
  for (const b of doc.blocks) {
    const text = b.text;
    if (pat && num && pat.test(text)) {
      // matches any numbered ref; narrow by number when present in text
      out.push(text);
    }
  }
  // keep it bounded
  return out.slice(0, 12);
}

/**
 * Artifact vision verification — STUB.
 *
 * Deferred until ChatMessage.images + adapter support (Stage 5+): the
 * Python pass sends figure images to a vision role; the TS ChatMessage has
 * no images field and no adapter sends image blocks yet. The pure helpers
 * this pass needs (`findMentions`, `nearPageBlocks`) are ported and tested.
 */
export async function verifyArtifacts(): Promise<ReviewComment[]> {
  return [];
}

export function nearPageBlocks(
  doc: Document,
  page: number | undefined,
  window = 6,
): string[] {
  if (page === undefined) return [];
  const same = doc.blocks.filter((b) => b.page === page).map((b) => b.text);
  if (same.length > 0) return same.slice(0, window);
  return [];
}

// ------------------------------------------------------- defense-adjudication --

/**
 * Per-comment quality gate: authors' defense -> adjudication.
 *
 * With a decision model configured, verdicts + recalibrated severity are
 * BATCHED decision questions (uphold/adjust/dismiss + severity rubric),
 * DM_BATCH_COMMENTS comments per decide() call, each listing entry carrying
 * the anchored manuscript passage next to the defense; an LLM rewrites only
 * 'adjust' comments. A per-batch failure upholds ONLY that batch. Without a
 * decider, the strong-model adjudicator adjudicates per comment (pre-7e
 * behavior, byte-identical call sequences). Gate failures never drop a
 * comment.
 *
 * Deep plans (defense_second_round) run the whole gate a second time over
 * the survivors: only comments that withstand two independent adversarial
 * rounds reach the report, with the second round's severity verdict final.
 *
 * Port of Python claims.py defense_round + _defense_round_dm (4132423).
 */
export async function defenseRound(init: {
  callJson: CallJson;
  doc: Document;
  candidates: ReviewComment[];
  settings: AppSettings;
  /** Decision caller (orchestrator RolePool.decide shim); absent = LLM gate. */
  decide?: DecisionCaller;
  onEvent?: ClaimProgress;
}): Promise<{ kept: ReviewComment[]; budget?: BudgetExceeded }> {
  const { callJson, doc, candidates, settings, decide, onEvent } = init;
  const preset = depthPreset(settings.review);
  if (!preset.defenseRound || candidates.length === 0) return { kept: [...candidates] };

  let out: ReviewComment[];
  if (decide !== undefined) {
    out = await defenseRoundDm({ callJson, doc, candidates, decide, preset });
  } else {
    out = await defenseRoundLlm({ callJson, doc, candidates, preset });
  }
  if (preset.defenseSecondRound && out.length > 0 && out.length < candidates.length) {
    onEvent?.({
      stage: 'challenge',
      status: 'running',
      at: new Date().toISOString(),
      detail: `second defense round on ${out.length} upheld comments`,
    });
    if (decide !== undefined) {
      out = await defenseRoundDm({ callJson, doc, candidates: out, decide, preset });
    } else {
      out = await defenseRoundLlm({ callJson, doc, candidates: out, preset });
    }
  }
  return { kept: out };
}

/** ReviewComment as a raw comment dict for the DM listing (Python c.get). */
function commentDict(c: ReviewComment): Record<string, unknown> {
  const o: Record<string, unknown> = {
    title: c.title ?? '',
    quote: c.quote ?? '',
    message: c.comment ?? '',
    score: c.severity,
  };
  if (c.paragraphAnchor !== undefined) o['paragraph_anchor'] = c.paragraphAnchor;
  if (c.category !== undefined) o['category'] = c.category;
  return o;
}

function dictToComment(o: Record<string, unknown>, base: ReviewComment): ReviewComment {
  const merged: ReviewComment = { ...base };
  const anyMerged = merged as unknown as Record<string, unknown>;
  if (typeof o['title'] === 'string') anyMerged['title'] = o['title'];
  if (typeof o['paragraph_anchor'] === 'string')
    merged.paragraphAnchor = o['paragraph_anchor'];
  if (typeof o['quote'] === 'string') merged.quote = o['quote'];
  if (typeof o['message'] === 'string') merged.comment = o['message'];
  if (typeof o['score'] === 'number')
    merged.severity = Math.min(1, Math.max(0, o['score']));
  if (typeof o['category'] === 'string') merged.category = o['category'];
  return merged;
}

/**
 * Python `_dm_listing`: comment + defense + the manuscript passage the
 * comment is anchored to. The passage is the evidence an adjudicator needs
 * to check a defense against what the paper actually says; without it a
 * glib defense wins by assertion.
 */
export function dmListing(
  cands: Record<string, unknown>[],
  defenses: string[],
  passages: string[],
): string {
  return cands
    .map((c, i) => {
      const n = i + 1;
      return (
        `${n}. [${String(c['title'] ?? '').slice(0, 70)}] severity=${c['score']} ` +
        `message=${String(c['message'] ?? '').slice(0, 300)}\n` +
        `   defense: ${defenses[i]!.slice(0, 300)}\n` +
        `   passage: ${passages[i]!.slice(0, 500)}`
      );
    })
    .join('\n');
}

async function defenseRoundDm(init: {
  callJson: CallJson;
  doc: Document;
  candidates: ReviewComment[];
  decide: DecisionCaller;
  preset: { maxParallelCalls: number };
}): Promise<ReviewComment[]> {
  const { callJson, doc, candidates, decide } = init;
  // Authors' best honest defense per comment (small model), in parallel.
  const defenseTexts = await mapPool(
    candidates,
    init.preset.maxParallelCalls,
    async (c) => {
      const anchor = c.paragraphAnchor || c.quote || '';
      const passage = passageFor(doc, anchor) ?? '(anchor not found in document)';
      const defense = await callJsonWithRepair(
        callJson,
        'small',
        promptsClaims.DEFENSE_SYSTEM,
        promptsClaims.defenseUser({
          title: c.title ?? '',
          quote: (c.quote || '').slice(0, 600),
          message: (c.comment || '').slice(0, 1500),
          passage: passage.slice(0, 2500),
        }),
        'defense',
      );
      if (defense.kind !== 'ok') return '(defense drafting failed)';
      const dObj =
        typeof defense.value === 'object' && defense.value !== null
          ? (defense.value as Record<string, unknown>)
          : {};
      return (
        `[${typeof dObj['defense_strength'] === 'string' ? dObj['defense_strength'] : 'unknown'}] ` +
        String(dObj['defense'] ?? '').slice(0, 1200)
      );
    },
  );
  const defenses = defenseTexts.map((r) =>
    r.ok ? r.value : '(defense drafting failed)',
  );
  const passages = candidates.map(
    (c) =>
      passageFor(doc, c.paragraphAnchor || c.quote || '') ??
      '(anchor not found in document)',
  );
  const dicts = candidates.map(commentDict);
  const sevMap: Record<string, number> = {
    polish: 0.25,
    minor: 0.45,
    major: 0.7,
    invalidating: 0.9,
  };
  const kept: ReviewComment[] = [];
  const toAdjust: [number, ReviewComment][] = []; // [original candidate index, comment]
  for (let lo = 0; lo < candidates.length; lo += DM_BATCH_COMMENTS) {
    const batch = dicts.slice(lo, lo + DM_BATCH_COMMENTS);
    const bDefenses = defenses.slice(lo, lo + DM_BATCH_COMMENTS);
    const bPassages = passages.slice(lo, lo + DM_BATCH_COMMENTS);
    const questions: DecisionQuestion[] = [];
    for (let i = 1; i <= batch.length; i++) {
      questions.push({
        type: 'choice',
        name: `verdict_${i}`,
        instructions:
          `Adjudicate comment ${i} after reading its authors' defense ` +
          'and the manuscript passage it is anchored to — check the ' +
          "defense's claims against the passage, not just its rhetoric. " +
          'dismiss = the defense refutes it; adjust = partially right, ' +
          'severity or wording needs correction; uphold = it stands.',
        choices: ['uphold', 'adjust', 'dismiss'].map((v) => ({ value: v })),
      });
      questions.push({
        type: 'score',
        name: `severity_${i}`,
        instructions: `Recalibrated severity for comment ${i} (if it stands).`,
        levels: [
          { label: 'polish', description: '0.1-0.34' },
          { label: 'minor', description: '0.35-0.59' },
          { label: 'major', description: '0.6-0.79' },
          { label: 'invalidating', description: '0.8-1.0' },
        ],
      });
    }
    const listing = dmListing(batch, bDefenses, bPassages);
    let dm: DecisionResult | undefined;
    try {
      dm = await decide(
        (
          `Manuscript: ${doc.title}\n\nComments with defenses and the ` +
          `manuscript passages they are anchored to:\n\n${listing}`
        ).slice(0, 60_000),
        questions,
        'dm_defense',
      );
    } catch {
      dm = undefined;
    }
    if (dm === undefined) {
      // DM adjudication failed: this batch upheld (nothing lost)
      kept.push(...candidates.slice(lo, lo + DM_BATCH_COMMENTS).map((c) => ({ ...c })));
      continue;
    }
    for (let i = 1; i <= batch.length; i++) {
      const v = answer(dm, `verdict_${i}`);
      const verdict = v?.choice ?? 'uphold';
      if (verdict === 'dismiss') continue;
      const base = candidates[lo + i - 1]!;
      const cc: ReviewComment = { ...base };
      const sv = answer(dm, `severity_${i}`);
      if (sv !== undefined && sv.probabilities.length > 0) {
        let best: Record<string, unknown> | undefined;
        for (const p of sv.probabilities) {
          if (
            best === undefined ||
            Number(p['probability'] ?? 0) > Number(best['probability'] ?? 0)
          ) {
            best = p;
          }
        }
        const label = best?.['label'];
        if (typeof label === 'string' && label in sevMap) {
          cc.severity = sevMap[label]!;
        }
      }
      if (verdict === 'adjust') {
        toAdjust.push([lo + i - 1, cc]);
      } else {
        kept.push(cc);
      }
    }
  }

  // LLM rewrites only the adjusted comments (usually few)
  for (const [idx, cc] of toAdjust) {
    try {
      const rewrite = await callJsonWithRepair(
        callJson,
        'small',
        promptsClaims.ADJUDICATION_SYSTEM,
        promptsClaims.adjudicationUser({
          title: cc.title ?? '',
          quote: (cc.quote || '').slice(0, 600),
          message: (cc.comment || '').slice(0, 1500),
          score: cc.severity,
          defenseStrength: 'adjusted by decision model',
          defense: defenses[idx]!.slice(0, 2000),
          passage: passages[idx]!.slice(0, 2500),
        }),
        'adjudication',
      );
      if (rewrite.kind !== 'ok') {
        kept.push(cc);
        continue;
      }
      const rObj =
        typeof rewrite.value === 'object' && rewrite.value !== null
          ? (rewrite.value as Record<string, unknown>)
          : {};
      const final =
        typeof rObj['comment'] === 'object' && rObj['comment'] !== null
          ? (rObj['comment'] as Record<string, unknown>)
          : undefined;
      if (final && typeof final['message'] === 'string' && final['message']) {
        kept.push(dictToComment(final, cc));
      } else {
        kept.push(cc);
      }
    } catch {
      kept.push(cc);
    }
  }
  return kept;
}

async function defenseRoundLlm(init: {
  callJson: CallJson;
  doc: Document;
  candidates: ReviewComment[];
  preset: { maxParallelCalls: number };
}): Promise<ReviewComment[]> {
  const { callJson, doc, candidates, preset } = init;
  const results: PoolResult<ReviewComment | null>[] = await mapPool(
    candidates,
    preset.maxParallelCalls,
    async (c): Promise<ReviewComment | null> => {
      const anchor = c.paragraphAnchor || c.quote || '';
      const passage = passageFor(doc, anchor) ?? '(anchor not found in document)';
      const defense = await callJsonWithRepair(
        callJson,
        'small',
        promptsClaims.DEFENSE_SYSTEM,
        promptsClaims.defenseUser({
          title: '', // Python passes c.get("title", "") — ReviewComment has no title field
          quote: (c.quote || '').slice(0, 600),
          message: (c.comment || '').slice(0, 1500),
          passage: passage.slice(0, 2500),
        }),
        'defense',
      );
      if (defense.kind !== 'ok') return c; // gate failure never drops a comment
      const dObj =
        typeof defense.value === 'object' && defense.value !== null
          ? (defense.value as Record<string, unknown>)
          : {};
      const adjudication = await callJsonWithRepair(
        callJson,
        'strong',
        promptsClaims.ADJUDICATION_SYSTEM,
        promptsClaims.adjudicationUser({
          title: '',
          quote: (c.quote || '').slice(0, 600),
          message: (c.comment || '').slice(0, 1500),
          score: c.severity,
          defenseStrength:
            typeof dObj['defense_strength'] === 'string'
              ? dObj['defense_strength']
              : 'unknown',
          defense: String(dObj['defense'] ?? '').slice(0, 2000),
          passage: passage.slice(0, 2500),
        }),
        'adjudication',
      );
      if (adjudication.kind !== 'ok') return c;
      const aObj =
        typeof adjudication.value === 'object' && adjudication.value !== null
          ? (adjudication.value as Record<string, unknown>)
          : {};
      const verdict = aObj['verdict'];
      if (verdict === 'dismissed') return null;
      const final =
        typeof aObj['comment'] === 'object' && aObj['comment'] !== null
          ? (aObj['comment'] as Record<string, unknown>)
          : undefined;
      if (final && typeof final['message'] === 'string' && final['message']) {
        // preserve provenance fields from the original candidate
        const merged: ReviewComment = { ...c };
        const mergedAny = merged as unknown as Record<string, unknown>;
        const f = final as Record<string, unknown>;
        if (typeof f['title'] === 'string') mergedAny['title'] = f['title'];
        if (typeof f['paragraph_anchor'] === 'string')
          merged.paragraphAnchor = f['paragraph_anchor'];
        if (typeof f['quote'] === 'string') merged.quote = f['quote'];
        merged.comment = f['message'] as string;
        if (typeof f['score'] === 'number')
          merged.severity = Math.min(1, Math.max(0, f['score']));
        if (typeof f['category'] === 'string') merged.category = f['category'];
        return merged;
      }
      return c;
    },
  );

  const kept: ReviewComment[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.ok) {
      // null verdict === dismissed: the comment drops
      if (r.value !== null) kept.push(r.value);
    } else {
      // gate failure (pool-level error) never drops a comment
      kept.push(candidates[i]!);
    }
  }
  return kept;
}

/**
 * Python `_passage_for`: the anchor's block plus one neighbor on each side
 * (order-1 .. order+2), joined with blank lines.
 */
export function passageFor(doc: Document, anchor: string): string | null {
  if (!anchor) return null;
  const hits = doc.findBlocks(anchor);
  if (hits.length === 0) return null;
  const b = hits[0]!;
  const lo = Math.max(0, b.order - 1);
  const hi = Math.min(doc.blocks.length, b.order + 2);
  return doc.blocks
    .slice(lo, hi)
    .map((x) => x.text)
    .join('\n\n');
}
