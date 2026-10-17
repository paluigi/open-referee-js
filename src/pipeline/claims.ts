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
import type { CallResult, StageProgress } from './orchestrator';
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
  };
}

/** JSON-repair retry (Python RolePool.complete_json): one replay with the
 * repair suffix when the first reply fails to parse. */
export async function callJsonWithRepair(
  callJson: CallJson,
  role: 'strong' | 'small',
  system: string,
  user: string,
): Promise<CallResult> {
  const res = await callJson(role, system, user);
  if (res.kind !== 'invalid_json') return res;
  const repairUser = `${user}\n\nYour previous reply was not valid JSON. Reply again with ONLY the required JSON object, no prose, no code fences.`;
  return callJson(role, system, repairUser);
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
  onEvent?: ClaimProgress;
  /** A worker failing (LLMError/invalid JSON even after repair) marks the verify stage partial. */
  onWorkerError?: () => void;
}): Promise<{ comments: ReviewComment[]; budget?: BudgetExceeded }> {
  const { callJson, doc, claims, settings, onEvent, onWorkerError } = init;
  const preset = depthPreset(settings.review);
  const order: Record<string, number> = { central: 0, supporting: 1, peripheral: 2 };
  const ordered = [...claims].sort(
    (a, b) =>
      (order[String(a['importance']).toLowerCase()] ?? 1) -
      (order[String(b['importance']).toLowerCase()] ?? 1),
  );
  const selected = ordered.slice(0, preset.maxClaims);

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
    const res = await callJsonWithRepair(callJson, role, system, user);
    if (res.kind !== 'ok' && res.kind !== 'budget') onWorkerError?.();
    let comments: ReviewComment[] = [];
    if (res.kind === 'ok') {
      const raw = (res.value as { comments?: unknown } | null)?.['comments'];
      if (Array.isArray(raw)) comments = raw.map((c) => normalizeComment(c, claim));
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
 * Only for comments whose anchor resolves to document text (unanchored ones
 * go straight to the meta-reviewer, which re-checks them globally). Gate
 * failure never drops a comment.
 */
export async function defenseRound(init: {
  callJson: CallJson;
  doc: Document;
  candidates: ReviewComment[];
  settings: AppSettings;
  onEvent?: ClaimProgress;
}): Promise<{ kept: ReviewComment[]; budget?: BudgetExceeded }> {
  const { callJson, doc, candidates, settings, onEvent } = init;
  const preset = depthPreset(settings.review);
  if (!preset.defenseRound || candidates.length === 0) return { kept: [...candidates] };

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
  let budget: BudgetExceeded | undefined;
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
  onEvent?.(
    {
      stage: 'challenge',
      status: 'running',
      at: new Date().toISOString(),
      detail: `defense gate: ${kept.length}/${candidates.length} comments upheld`,
    },
    undefined,
  );
  return { kept, budget };
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
