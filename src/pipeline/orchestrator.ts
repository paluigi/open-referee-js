/**
 * The review pipeline orchestrator (Stage 4 verification engine).
 *
 * Port of Python `open_referee/pipeline/orchestrator.py`, narrowed to:
 * triage -> claims -> survey -> verify (per-claim workers + lenses +
 * whole-paper) -> challenge (per section, Python `_challenge` semantics,
 * ending in the defense-adjudication gate) -> meta -> validate -> assemble.
 *
 * Implemented as an async generator: every StageEvent is yielded AND passed
 * to `onEvent`; the generator's return value is the final RunState with the
 * assembled ReviewReport. The run never throws away its work: a stage whose
 * response fails to parse is marked failed (partial=true) and the pipeline
 * continues; a tripped budget cap marks the run partial, skips the remaining
 * stages, and still assembles a report from whatever exists.
 */

import type { AppSettings } from '../config/schema';
import type { Document } from '../ingestion/document';
import type { ChatMessage, ChatProvider, ModelSpec } from '../providers/base';
import { LLMError } from '../providers/base';
import { BudgetExceeded, UsageLedger } from '../providers/usage';
import { appendEvent, saveRun } from '../runs/store';
import type { ReviewComment, ReviewReport, UsageSummary } from '../report/models';
import {
  challengerPrompt,
  challengerSystem,
  empiricalVerifierSystem,
  litVerifierSystem,
  mathVerifierSystem,
  metaPrompt,
  metaSystem,
  proseVerifierSystem,
  triagePrompt,
  triageSystem,
  validatorPrompt,
  validatorSystem,
  verifierPrompt,
  wholePaperChallengerPrompt,
  wholePaperChallengerSystem,
  wholePaperVerifierPrompt,
  wholePaperVerifierSystem,
} from './prompts';
import {
  defenseRound,
  depthPreset,
  callJsonWithRepair,
  runClaimInventory,
  verifyClaims,
  type CallJson,
} from './claims';
import { extractJson } from './json';
import { normalizeText } from '../ingestion/document';
import type { RunState, Stage, StageEvent } from './state';
import { createRunState, setStage, stageStatus } from './state';

const MAX_MANUSCRIPT_CHARS = 120_000;
const MAX_SECTION_CHARS = 40_000;

export interface StageProgress {
  unitsDone: number;
  unitsTotal: number;
}

export interface RunReviewOptions {
  doc: Document;
  settings: AppSettings;
  /**
   * Stage 1 calls only the `strong` role; `small` is accepted now so callers
   * are wired for the later stages (claims/verify/defense) that use it.
   */
  providers: { strong: ChatProvider; small: ChatProvider };
  onEvent?: (e: StageEvent, progress?: StageProgress) => void;
}

/** Role name as used in settings.roles and ledger bookkeeping. */
type Role = 'strong' | 'small';

/** Result of one budget-checked JSON call (settled by `settle`). */
export type CallResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid_json' }
  | { kind: 'llm_error'; error: LLMError }
  | { kind: 'budget'; error: BudgetExceeded };

/** Internal pipeline artifacts accumulated across stages. */
interface Artifacts {
  triage?: Record<string, unknown>;
  /** claim inventory (claims stage) */
  claims: Record<string, unknown>[];
  survey?: unknown;
  /** verify-stage output, before the challenger pass */
  candidates: ReviewComment[];
  /** meta-review markdown */
  overall: string;
  recommendation?: string;
}

/**
 * Sections worth challenging: (title, text) pairs; falls back to one big
 * chunk. Mirrors Python `_reviewable_sections`.
 */
function reviewableSections(doc: Document): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  for (const s of doc.sections) {
    const text = doc.blocks
      .slice(s.startBlock, s.endBlock)
      .map((b) => b.text)
      .join('\n\n');
    if (text.length > 400) {
      out.push({ title: s.title, text });
    }
  }
  if (out.length === 0) {
    out.push({ title: 'Full manuscript', text: doc.fullText() });
  }
  return out;
}

/** Python `_norm(t)[:120]`: normalized anchor prefix used for claim matching. */
function normPrefix(t: string): string {
  return normalizeText(t).toLowerCase().slice(0, 120);
}

/** Python `_anchor_in`: the anchor's first 120 normalized chars appear in text. */
function anchorIn(anchor: string, text: string): boolean {
  return normalizeText(text).toLowerCase().includes(normPrefix(anchor));
}

/** Python `_lenses_for`: verifier lens selection based on triage fields. */
function lensesFor(
  triage: Record<string, unknown>,
): { name: string; system: string }[] {
  const mathDensity = String(triage['mathematical_density'] ?? '').toLowerCase();
  const statContent = String(triage['statistical_content'] ?? '').toLowerCase();
  const style = String(triage['methodological_style'] ?? '').toLowerCase();

  const lenses: { name: string; system: string }[] = [
    { name: 'prose', system: proseVerifierSystem },
  ];
  if (
    ['light', 'moderate', 'heavy'].includes(mathDensity) ||
    style.includes('theorem') ||
    ['moderate', 'heavy'].includes(mathDensity)
  ) {
    lenses.push({ name: 'math', system: mathVerifierSystem });
  }
  if (
    (statContent !== '' && statContent !== 'none') ||
    style.includes('empirical') ||
    statContent.includes('causal')
  ) {
    lenses.push({ name: 'empirical', system: empiricalVerifierSystem });
  }
  // literature coherence always runs: cheap and central to the review
  lenses.push({ name: 'lit', system: litVerifierSystem });
  return lenses;
}

/** Map a verifier/whole-paper worker's {comments:[...]} to ReviewComments. */
function normalizeWorkerComments(
  value: unknown,
  sectionTitle: string,
): ReviewComment[] {
  const out: ReviewComment[] = [];
  const raw = (value as { comments?: unknown } | null)?.['comments'];
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    out.push({
      section: typeof o['section'] === 'string' ? o['section'] : sectionTitle,
      quote: typeof o['quote'] === 'string' ? o['quote'] : '',
      comment: typeof o['message'] === 'string' ? o['message'] : '',
      severity:
        typeof o['score'] === 'number' ? Math.min(1, Math.max(0, o['score'])) : 0.3,
      paragraphAnchor:
        typeof o['paragraph_anchor'] === 'string' ? o['paragraph_anchor'] : undefined,
      category: typeof o['category'] === 'string' ? o['category'] : undefined,
    });
  }
  return out;
}

/** Map a challenger validated/new_comments entry to a ReviewComment. */
function challengerComment(
  o: Record<string, unknown>,
  sectionTitle: string,
  _raw: unknown,
): ReviewComment {
  return {
    section: typeof o['section'] === 'string' ? o['section'] : sectionTitle,
    quote: typeof o['quote'] === 'string' ? o['quote'] : '',
    comment: typeof o['message'] === 'string' ? o['message'] : '',
    severity:
      typeof o['score'] === 'number' ? Math.min(1, Math.max(0, o['score'])) : 0.3,
    paragraphAnchor:
      typeof o['paragraph_anchor'] === 'string' ? o['paragraph_anchor'] : undefined,
    category: typeof o['category'] === 'string' ? o['category'] : undefined,
  };
}

function newRunId(): string {
  // Parity with Python: uuid4().hex[:12] — full hex, no hyphens.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return Math.random().toString(16).slice(2, 14);
}

/**
 * Run the Stage-1 review pipeline.
 *
 * Yields every StageEvent (also forwarded to `opts.onEvent`); the return
 * value is the final RunState (`result.value.report` holds the report).
 */
export async function* runReview(
  opts: RunReviewOptions,
): AsyncGenerator<StageEvent, RunState, undefined> {
  const { doc, settings, providers, onEvent } = opts;
  const state: RunState = createRunState(newRunId(), doc.title);
  const ledger = new UsageLedger(settings.maxCostUsd, settings.pricing);

  await saveRun(state);

  /**
   * The stage sequence. Unexpected exceptions (IndexedDB failure in emit, a
   * non-LLMError throw from a provider) propagate to the driver below, which
   * fails the run persistently before rethrowing — a run must never stay in
   * 'running' forever.
   */
  const pipeline = async function* (): AsyncGenerator<StageEvent, void, undefined> {
    const artifacts: Artifacts = { claims: [], candidates: [], overall: '' };
    let budgetError: BudgetExceeded | undefined;
    const preset = depthPreset(settings.review);
    /** challenge-stage output (validated + new_comments), feeding meta. */
    const challengeValidated: ReviewComment[] = [];

    const spec = (role: Role): ModelSpec => {
      const rc = settings.roles[role];
      return {
        provider: role,
        model: rc.model,
        temperature: rc.temperature ?? 0.2,
        maxTokens: rc.maxTokens ?? 4096,
      };
    };

    /** Persist + fan out one stage transition; yields it back to the caller. */
    async function* emit(
      stage: Stage,
      status: StageEvent['status'],
      detail?: string,
      progress?: StageProgress,
    ): AsyncGenerator<StageEvent, void, undefined> {
      const e: StageEvent = setStage(state, stage, status, detail);
      await saveRun(state);
      await appendEvent(state.runId, e);
      onEvent?.(e, progress);
      yield e;
    }

    const manuscript = doc.fullText().slice(0, MAX_MANUSCRIPT_CHARS);

    /** One budget-checked, usage-recorded, JSON-parsed completion. */
    async function callJson(
      role: Role,
      system: string,
      user: string,
    ): Promise<CallResult> {
      const s = spec(role);
      // Budget check BEFORE the call; unpriced models project 0.
      const pricing = settings.pricing[s.model];
      const estIn = (system.length + user.length) / 3;
      const estOut = Math.min(s.maxTokens, Math.max(1000, estIn / 4));
      const projected = pricing
        ? (estIn * pricing.input + estOut * pricing.output) / 1_000_000
        : 0;
      try {
        ledger.checkBudget(projected);
      } catch (err) {
        if (err instanceof BudgetExceeded) return { kind: 'budget', error: err };
        throw err;
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      let resp;
      try {
        resp = await providers[role].complete(messages, s);
      } catch (err) {
        if (err instanceof LLMError) return { kind: 'llm_error', error: err };
        throw err;
      }
      ledger.record(s.model, role, resp);
      try {
        return { kind: 'ok', value: extractJson(resp.content) };
      } catch {
        return { kind: 'invalid_json' };
      }
    }

    /** Settle a stage result; true when the pipeline should keep going. */
    async function* settle(
      stage: Stage,
      result: CallResult,
      onOk: (value: unknown) => void,
      progress?: StageProgress,
    ): AsyncGenerator<StageEvent, boolean, undefined> {
      if (result.kind === 'ok') {
        onOk(result.value);
        yield* emit(stage, 'done', undefined, progress);
        return true;
      }
      if (result.kind === 'budget') {
        // The caller handles the global budget drain; do not mark the stage here.
        return false;
      }
      if (result.kind === 'invalid_json') {
        state.partial = true;
        await saveRun(state);
        yield* emit(stage, 'failed', 'invalid JSON in model response', progress);
        return true;
      }
      state.partial = true;
      await saveRun(state);
      yield* emit(stage, 'failed', `LLM error: ${result.error.message}`, progress);
      return true;
    }

    // ------------------------------------------------------------ 1. triage --
    yield* emit('triage', 'running');
    const triageRes = await callJson(
      'strong',
      triageSystem,
      triagePrompt(doc.title, manuscript),
    );
    {
      const keep = yield* settle('triage', triageRes, (v) => {
        artifacts.triage = (v ?? {}) as Record<string, unknown>;
      });
      if (!keep) {
        budgetError = triageRes.kind === 'budget' ? triageRes.error : undefined;
      }
    }

    // ------------------------------------------------------------ 1b. claims --
    if (!budgetError) {
      yield* emit('claims', 'running');
      const claimJson: CallJson = (role, system, user) => callJson(role, system, user);
      const inv = await runClaimInventory({
        callJson: claimJson,
        doc,
        triage: artifacts.triage ?? {},
        settings,
      });
      if (inv.budget) budgetError = inv.budget;
      artifacts.claims = inv.claims;
      if (budgetError) {
        yield* emit('claims', 'failed', `budget cap reached: ${budgetError.message}`);
      } else if (inv.claims.length > 0) {
        yield* emit('claims', 'done', `${inv.claims.length} claims catalogued`);
      } else {
        // Python logs a warning and continues claimless.
        state.partial = true;
        await saveRun(state);
        yield* emit('claims', 'failed', 'claim inventory failed or produced no claims');
      }
    }

    // ------------------------------------------------------------ 2. survey --
    if (!budgetError) {
      yield* emit('survey', 'running');
      const summary = String(artifacts.triage?.summary ?? doc.title);
      const surveyRes = await callJson(
        'strong',
        '',
        `Survey the literature context for: ${summary}`,
      );
      const keep = yield* settle('survey', surveyRes, (v) => {
        // Stage 1: store the raw skeleton; no network search.
        artifacts.survey = v;
      });
      if (!keep && surveyRes.kind === 'budget') budgetError = surveyRes.error;
    }

    // --------------------------------------------------- 3. verify --
    // Per-claim workers first (the primary engine), then per-section lenses
    // (depth preset), then the whole-paper coherence pass. Mirrors Python
    // `_verify` minus artifact vision (deferred to Stage 5+).
    if (!budgetError) {
      yield* emit('verify', 'running');
      let unitsDone = 0;
      let stageBroken = false;

      // 3a. per-claim verification workers
      if (artifacts.claims.length > 0) {
        const claimJson: CallJson = (role, system, user) =>
          callJson(role, system, user);
        const total = artifacts.claims.length;
        const claimRun = await verifyClaims({
          callJson: claimJson,
          doc,
          claims: artifacts.claims,
          settings,
          onWorkerError: () => {
            stageBroken = true;
          },
          onEvent: () => {
            unitsDone += 1;
            onEvent?.(
              { stage: 'verify', status: 'running', at: new Date().toISOString() },
              { unitsDone, unitsTotal: total },
            );
          },
        });
        artifacts.candidates.push(...claimRun.comments);
        if (claimRun.budget) budgetError = claimRun.budget;
        yield* emit('verify', 'running', `per-claim verification`, {
          unitsDone,
          unitsTotal: total,
        });
      }

      // 3b. per-section lenses (Python `_lenses_for` + `_reviewable_sections`)
      if (preset.perSectionLenses) {
        const lenses = lensesFor(artifacts.triage ?? {});
        const sections = reviewableSections(doc);
        const lensTotal = sections.length * lenses.length;
        for (const lens of lenses) {
          for (const sec of sections) {
            const res = await callJsonWithRepair(
              callJson,
              'small',
              lens.system,
              verifierPrompt(
                `${sec.title} — ${lens.name} lens`,
                '',
                sec.text.slice(0, MAX_SECTION_CHARS),
              ),
            );
            unitsDone += 1;
            const nowProgress: StageProgress = { unitsDone, unitsTotal: lensTotal };
            if (res.kind === 'ok') {
              artifacts.candidates.push(
                ...normalizeWorkerComments(res.value, sec.title),
              );
              yield* emit(
                'verify',
                'running',
                `verified [${lens.name}]: ${sec.title}`,
                nowProgress,
              );
            } else if (res.kind === 'budget') {
              budgetError = res.error;
              break;
            } else {
              stageBroken = true;
              yield* emit(
                'verify',
                'running',
                res.kind === 'invalid_json'
                  ? `invalid JSON for [${lens.name}]: ${sec.title}`
                  : `LLM error on [${lens.name}] ${sec.title}: ${res.error.message}`,
                nowProgress,
              );
            }
          }
          if (budgetError) break;
        }
      }

      // 3c. whole-paper coherence pass (strong model, full text)
      if (!budgetError && preset.wholePaperPasses) {
        const wpRes = await callJsonWithRepair(
          callJson,
          'strong',
          wholePaperVerifierSystem,
          wholePaperVerifierPrompt(doc.title, manuscript),
        );
        if (wpRes.kind === 'ok') {
          const n = normalizeWorkerComments(wpRes.value, 'Full manuscript');
          artifacts.candidates.push(...n);
          yield* emit('verify', 'running', `whole-paper pass: ${n.length} findings`);
        } else if (wpRes.kind === 'budget') {
          budgetError = wpRes.error;
        } else {
          stageBroken = true;
          yield* emit(
            'verify',
            'running',
            wpRes.kind === 'invalid_json'
              ? 'whole-paper verifier returned invalid JSON'
              : `whole-paper verifier failed: ${wpRes.error.message}`,
          );
        }
      }

      if (budgetError) {
        // fall through to the assemble drain
      } else if (stageBroken) {
        state.partial = true;
        await saveRun(state);
        yield* emit('verify', 'failed', 'one or more verification workers failed');
      } else {
        yield* emit('verify', 'done', undefined, {
          unitsDone,
          unitsTotal: Math.max(unitsDone, 1),
        });
      }
    }

    // ------------------------------------------------------ 4. challenge --
    // Python `_challenge` semantics: per-section challenger passes over the
    // CANDIDATE list (claims + lens findings), then a whole-paper challenger
    // validates what no section challenger claimed and hunts global issues.
    if (!budgetError) {
      yield* emit('challenge', 'running');
      const sections = reviewableSections(doc);
      let unitsDone = 0;
      let stageBroken = false;
      const claimedAnchors = new Set<string>();
      const addClaimed = (comments: ReviewComment[]) => {
        for (const c of comments)
          claimedAnchors.add(normPrefix(c.paragraphAnchor ?? ''));
      };

      for (const sec of sections) {
        const cands = artifacts.candidates.filter(
          (c) =>
            (c.paragraphAnchor ?? '') !== '' &&
            anchorIn(c.paragraphAnchor ?? '', sec.text),
        );
        const res = await callJsonWithRepair(
          callJson,
          'strong',
          challengerSystem,
          challengerPrompt(
            sec.title,
            '',
            sec.text.slice(0, MAX_SECTION_CHARS),
            // Python: json.dumps(cands, indent=1)[:20_000]
            JSON.stringify(cands, null, 1).slice(0, 20_000),
          ),
        );
        unitsDone += 1;
        const nowProgress: StageProgress = { unitsDone, unitsTotal: sections.length };
        if (res.kind === 'ok') {
          const o = (res.value ?? {}) as Record<string, unknown>;
          // kept: challenger verdicts that were not dropped
          const kept: ReviewComment[] = [];
          if (Array.isArray(o['validated'])) {
            for (const v of o['validated']) {
              if (typeof v !== 'object' || v === null) continue;
              const vo = v as Record<string, unknown>;
              if (vo['verdict'] === 'dropped') continue;
              const src =
                typeof vo['paragraph_anchor'] === 'string'
                  ? vo['paragraph_anchor']
                  : typeof vo['anchor'] === 'string'
                    ? vo['anchor']
                    : undefined;
              const match =
                src !== undefined
                  ? (cands.find((c) => (c.paragraphAnchor ?? '') === src) ??
                    cands.find(
                      (c) =>
                        normPrefix(c.paragraphAnchor ?? '') === normPrefix(src) ||
                        c.quote === vo['quote'],
                    ))
                  : undefined;
              if (match) {
                const merged: ReviewComment = { ...match };
                if (typeof vo['paragraph_anchor'] === 'string')
                  merged.paragraphAnchor = vo['paragraph_anchor'];
                if (typeof vo['quote'] === 'string') merged.quote = vo['quote'];
                if (typeof vo['message'] === 'string') merged.comment = vo['message'];
                if (typeof vo['score'] === 'number')
                  merged.severity = Math.min(1, Math.max(0, vo['score']));
                kept.push(merged);
              } else {
                kept.push(challengerComment(vo, sec.title, res.value));
              }
            }
          }
          // new_comments: hunter findings from this section
          const fresh: ReviewComment[] = [];
          if (Array.isArray(o['new_comments'])) {
            for (const nc of o['new_comments'])
              fresh.push(challengerComment(nc, sec.title, res.value));
          }
          addClaimed(kept);
          addClaimed(fresh);
          challengeValidated.push(...kept, ...fresh);
          yield* emit('challenge', 'running', `challenged: ${sec.title}`, nowProgress);
        } else if (res.kind === 'budget') {
          budgetError = res.error;
          break;
        } else {
          stageBroken = true;
          // Python: on challenger failure the section's candidates pass through.
          challengeValidated.push(...cands);
          yield* emit(
            'challenge',
            'running',
            res.kind === 'invalid_json'
              ? `invalid JSON for section: ${sec.title}`
              : `LLM error on section ${sec.title}: ${res.error.message}`,
            nowProgress,
          );
        }
      }
      if (!budgetError) {
        // whole-paper challenge: validate cross-section candidates (those no
        // section challenger claimed) and hunt missed global weaknesses
        const wpCandidates = artifacts.candidates.filter(
          (c) => !claimedAnchors.has(normPrefix(c.paragraphAnchor ?? '')),
        );
        const wpRes = await callJsonWithRepair(
          callJson,
          'strong',
          wholePaperChallengerSystem,
          wholePaperChallengerPrompt(
            doc.title,
            manuscript,
            // Python: json.dumps(wp_candidates, indent=1)[:30_000]
            JSON.stringify(wpCandidates, null, 1).slice(0, 30_000),
          ),
        );
        if (wpRes.kind === 'ok') {
          const o = (wpRes.value ?? {}) as Record<string, unknown>;
          if (Array.isArray(o['validated'])) {
            for (const v of o['validated']) {
              if (typeof v !== 'object' || v === null) continue;
              const vo = v as Record<string, unknown>;
              if (vo['verdict'] === 'dropped') continue;
              const match = wpCandidates.find(
                (c) =>
                  normPrefix(c.paragraphAnchor ?? '') ===
                    normPrefix(
                      typeof vo['paragraph_anchor'] === 'string'
                        ? vo['paragraph_anchor']
                        : '',
                    ) || c.quote === vo['quote'],
              );
              if (match) {
                const merged: ReviewComment = { ...match };
                if (typeof vo['paragraph_anchor'] === 'string')
                  merged.paragraphAnchor = vo['paragraph_anchor'];
                if (typeof vo['quote'] === 'string') merged.quote = vo['quote'];
                if (typeof vo['message'] === 'string') merged.comment = vo['message'];
                if (typeof vo['score'] === 'number')
                  merged.severity = Math.min(1, Math.max(0, vo['score']));
                challengeValidated.push(merged);
              } else {
                challengeValidated.push(
                  challengerComment(vo, 'Full manuscript', wpRes.value),
                );
              }
            }
          }
          if (Array.isArray(o['new_comments'])) {
            for (const nc of o['new_comments'])
              challengeValidated.push(
                challengerComment(nc, 'Full manuscript', wpRes.value),
              );
          }
          yield* emit('challenge', 'running', 'whole-paper challenge done');
        } else if (wpRes.kind === 'budget') {
          budgetError = wpRes.error;
        } else {
          // Python logs and keeps going: candidates stay in the flow.
          stageBroken = true;
          yield* emit(
            'challenge',
            'running',
            wpRes.kind === 'invalid_json'
              ? 'whole-paper challenger returned invalid JSON'
              : `whole-paper challenger failed: ${wpRes.error.message}`,
          );
        }
      }
      if (budgetError) {
        // drained
      } else if (stageBroken) {
        state.partial = true;
        await saveRun(state);
        yield* emit('challenge', 'failed', 'one or more sections failed');
      } else {
        yield* emit('challenge', 'done', undefined, {
          unitsDone,
          unitsTotal: sections.length,
        });
      }

      // ------------------------------------------ challenge tail: defense --
      // Python parity: defense_round runs at the end of _challenge, so its
      // output (not the raw candidates) feeds meta and validate.
      if (!budgetError && preset.defenseRound && challengeValidated.length > 0) {
        yield* emit('challenge', 'running', 'defense gate');
        const gate = await defenseRound({
          callJson,
          doc,
          candidates: challengeValidated,
          settings,
        });
        challengeValidated.length = 0;
        challengeValidated.push(...gate.kept);
        if (gate.budget) budgetError = gate.budget;
      }
    }

    // -------------------------------------------------------------- 5. meta --
    if (!budgetError) {
      yield* emit('meta', 'running');
      // Python: json.dumps(validated, indent=1)[:60_000]
      const commentsJson = JSON.stringify(challengeValidated, null, 1).slice(0, 60_000);
      const metaRes = await callJson(
        'strong',
        metaSystem,
        metaPrompt(
          doc.title,
          JSON.stringify(artifacts.triage ?? {}),
          commentsJson,
          '',
          '',
        ),
      );
      if (metaRes.kind === 'ok') {
        const v = metaRes.value;
        if (typeof v === 'object' && v !== null && 'overall_feedback' in v) {
          const o = v as Record<string, unknown>;
          artifacts.overall =
            typeof o['overall_feedback'] === 'string' ? o['overall_feedback'] : '';
          if (typeof o['recommendation'] === 'string')
            artifacts.recommendation = o['recommendation'];
        } else if (typeof v === 'string') {
          artifacts.overall = v;
        } else {
          artifacts.overall = '';
        }
        yield* emit('meta', 'done');
      } else if (metaRes.kind === 'budget') {
        budgetError = metaRes.error;
      } else if (metaRes.kind === 'invalid_json') {
        // The meta stage may legitimately answer in plain markdown: use it.
        artifacts.overall = '(meta review unparseable)';
        state.partial = true;
        await saveRun(state);
        yield* emit('meta', 'failed', 'invalid JSON in model response');
      } else {
        artifacts.overall = '';
        state.partial = true;
        await saveRun(state);
        yield* emit('meta', 'failed', `LLM error: ${metaRes.error.message}`);
      }
    }

    // ---------------------------------------------------------- 6. validate --
    const validated: ReviewComment[] = [];
    if (!budgetError && challengeValidated.length > 0) {
      yield* emit('validate', 'running');
      // Python: json.dumps(validated, indent=1)[:60_000]
      const commentsJson = JSON.stringify(challengeValidated, null, 1).slice(0, 60_000);
      const valRes = await callJson(
        'strong',
        validatorSystem,
        validatorPrompt(doc.title, manuscript, commentsJson, artifacts.overall),
      );
      if (valRes.kind === 'ok') {
        const o = (valRes.value ?? {}) as Record<string, unknown>;
        const rejected = new Set<number>();
        if (Array.isArray(o['rejected'])) {
          for (const r of o['rejected']) {
            if (typeof r === 'number') rejected.add(r);
          }
        }
        // A fabricated criticism is worse than a missed one: drop rejected.
        challengeValidated.forEach((c, i) => {
          if (!rejected.has(i)) validated.push(c);
        });
        yield* emit('validate', 'done');
      } else if (valRes.kind === 'budget') {
        budgetError = valRes.error;
      } else {
        // Keep all candidates when validation itself fails.
        validated.push(...challengeValidated);
        state.partial = true;
        await saveRun(state);
        yield* emit(
          'validate',
          'failed',
          valRes.kind === 'invalid_json'
            ? 'invalid JSON in model response'
            : `LLM error: ${valRes.error.message}`,
        );
      }
    } else if (!budgetError) {
      yield* emit('validate', 'skipped', 'no candidates to validate');
    }

    // ---------------------------------------------------------- 7. assemble --
    if (budgetError) {
      // Mark the never-started stages skipped so the state machine is explicit.
      const order: Stage[] = [
        'triage',
        'claims',
        'survey',
        'verify',
        'challenge',
        'meta',
        'validate',
      ];
      for (const stage of order) {
        if (stageStatus(state, stage) === 'pending') {
          yield* emit(stage, 'skipped', 'budget cap reached earlier in the run');
        }
      }
      state.partial = true;
      await saveRun(state);
      yield* emit('assemble', 'skipped', `budget cap reached: ${budgetError.message}`);
    } else {
      yield* emit('assemble', 'running');
    }

    const recommendation =
      artifacts.recommendation ??
      /(?:^|\W)(major revision|minor revision|reject|accept)(?=\W|$)/i
        .exec(artifacts.overall)?.[1]
        ?.toLowerCase();

    const byRole = ledger.byRole();
    const totals = ledger.totalTokens();
    const usage: UsageSummary = {
      byRole,
      estimatedCostUsd: Math.round(ledger.totalCost() * 10_000) / 10_000,
      totalPromptTokens: totals.prompt,
      totalCompletionTokens: totals.completion,
    };

    const report: ReviewReport = {
      paperTitle: doc.title,
      recommendation,
      overall: artifacts.overall || '_(no meta-review produced)_',
      comments: validated,
      usage,
      partial: state.partial || budgetError !== undefined,
      generatedAt: new Date().toISOString(),
    };
    state.report = report;
    await saveRun(state);
    yield* emit(
      'assemble',
      'done',
      budgetError ? 'partial report assembled' : 'report ready',
    );
  }; // end pipeline

  // Driver: an unexpected error inside the pipeline fails the current stage,
  // marks the run partial+failed, persists that terminal state, and rethrows —
  // the run never remains 'running' in IndexedDB.
  try {
    yield* pipeline();
  } catch (err) {
    const stuck: Stage | undefined = (
      [
        'triage',
        'claims',
        'survey',
        'verify',
        'challenge',
        'meta',
        'validate',
        'assemble',
      ] as Stage[]
    ).find((s) => stageStatus(state, s) === 'running');
    if (stuck) {
      state.partial = true;
      const e = setStage(
        state,
        stuck,
        'failed',
        `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
      onEvent?.(e);
      // Best-effort persistence; if IndexedDB itself is down there is
      // nothing more we can do.
      await saveRun(state).catch(() => undefined);
      await appendEvent(state.runId, e).catch(() => undefined);
    } else {
      state.partial = true;
      await saveRun(state).catch(() => undefined);
    }
    throw err;
  }

  return state;
}
