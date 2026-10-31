/**
 * The review pipeline orchestrator (Stage 4 verification engine).
 *
 * Port of Python `open_referee/pipeline/orchestrator.py`, narrowed to:
 * triage -> claims -> survey (literature pack: OpenAlex + web router +
 * surveyor + Crossref missing-refs) -> scout (community discussion) ->
 * verify (per-claim workers + lenses + whole-paper) -> challenge (per
 * section, Python `_challenge` semantics, ending in the defense gate) ->
 * meta -> validate -> assemble.
 *
 * Deferred: Python's user-supplied literature path (pack.user_docs from
 * author PDFs + OpenAlex metadata matching, source='user_pdf') — the
 * browser app has no multi-document ingest yet; renderPack keeps the
 * user-docs line for parity but it is empty in production (Stage 6+).
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
import type { DecisionQuestion, DecisionResult } from '../providers/decisions';
import { answer } from '../providers/decisions';
import { BudgetExceeded, UsageLedger } from '../providers/usage';
import {
  BudgetHarness,
  BudgetInfeasible,
  callMaxTokens,
  CHARS_PER_TOKEN,
  documentStatsFromDoc,
  ledgerView,
  planKnobsFromPreset,
  PlanKnobs,
  type ReviewPlan,
} from './budget';
import { appendEvent, saveRun } from '../runs/store';
import type {
  CopyeditItem,
  ReviewComment,
  ReviewReport,
  UsageSummary,
} from '../report/models';
import {
  challengerPrompt,
  challengerSystem,
  clarityVerifierSystem,
  empiricalVerifierSystem,
  litVerifierSystem,
  mathVerifierSystem,
  metaPrompt,
  metaSystem,
  proseVerifierSystem,
  statsVerifierSystem,
  synthesisPrompt,
  synthesisSystem,
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
  depthPresetFromTier,
  callJsonWithRepair,
  runClaimInventory,
  verifyClaims,
  type CallJson,
} from './claims';
import { extractJson } from './json';
import { normalizeText } from '../ingestion/document';
import { similarityRatio } from '../util/sequence_matcher';
import {
  documentFromData,
  documentToData,
  type DocumentData,
} from '../ingestion/document_data';
import {
  emptyAudit,
  runBibliographyAudit,
  type BibliographyAudit,
} from './bibliography';
import { resolveAnchor, sectionOfBlock } from '../report/anchor';
import {
  contextPackFromArtifact,
  newContextPack,
  normalizeTitleKey,
  renderPack,
  type ContextPack,
  type LiteratureItem,
} from '../literature/types';
import { OpenAlexClient } from '../literature/openalex';
import { CrossrefClient } from '../literature/crossref';
import {
  renderResolutions,
  resolveReferences,
  type ResolutionClients,
  type ResolutionRecord,
} from '../literature/reference_resolution';
import { runCopyEditStage } from './copyedit';
import { findingToDict, runDeterministicChecks } from './checkers';
import { replanChoice, rankClaims, strategyCommittee } from './committee';
import { extractTables, extractTheorems } from '../ingestion/artifacts';
import { SearchRouter, type SearchApiKeys } from '../literature/search';
import { PeerReviewScout } from '../literature/scout';
import { surveySystem } from './prompts';
import type { RunState, Stage, StageArtifacts, StageEvent } from './state';
import { createRunState, setStage, stageStatus } from './state';

const MAX_MANUSCRIPT_CHARS = 120_000;
const MAX_SECTION_CHARS = 40_000;
/** Python MAX_CITATION_SCANS: key citations the scout scans. */
const MAX_CITATION_SCANS = 6;

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
  /**
   * Stage 7e: the optional decision model (settings.decisionRole). Absent
   * (or the role left unbound) = the DM layer is fully dormant: every stage
   * uses its labelled-LLM fallback and the e2e call sequences are
   * byte-identical to pre-7e.
   */
  decider?: DecisionCaller;
  /**
   * Session-only search-engine API keys (same treatment as provider keys
   * pre-vault). Absent/empty keys simply disable that engine.
   */
  searchApiKeys?: SearchApiKeys;
  onEvent?: (e: StageEvent, progress?: StageProgress) => void;
  /**
   * Resume a persisted run: re-enters at the first non-done stage and skips
   * stages whose saved artifact exists (Python `_stage_or_resume`). The
   * document snapshot rides in `resume.state.docData`; pass `providers` (and
   * optionally refreshed `settings`) to keep driving the run.
   */
  resume?: {
    state: RunState;
    settings?: AppSettings;
    providers?: { strong: ChatProvider; small: ChatProvider };
    /** Stage 7e: the decision caller for the resumed run. */
    decider?: DecisionCaller;
  };
}

/**
 * Python RolePool.decide: budget-checked (ledger), ledger-recorded under the
 * given call type, harness-notified. The orchestrator wraps the raw
 * DecisionsClient/FakeDecisionProvider into this shape.
 */
export type DecisionCaller = (
  input: string,
  questions: readonly DecisionQuestion[],
  callType: string,
) => Promise<DecisionResult | undefined>;

/** Role name as used in settings.roles and ledger bookkeeping. */
type Role = 'strong' | 'small';

/** Resolved ModelSpec for a role from settings (module-level helper). */
function specOf(settings: AppSettings, role: Role): ModelSpec {
  const rc = settings.roles[role];
  return {
    provider: role,
    model: rc.model,
    temperature: rc.temperature ?? 0.2,
    maxTokens: rc.maxTokens ?? 4096,
  };
}

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
  /** ContextPack from the survey (literature) stage — JSON-safe, resumed. */
  survey?: ContextPack;
  /** verify-stage output, before the challenger pass */
  candidates: ReviewComment[];
  /** challenge-stage output (validated + new_comments) — resumed. */
  challenge?: ReviewComment[];
  /** bibliography audit — resumed. */
  bibliography?: BibliographyAudit;
  /** meta-review markdown */
  overall: string;
  recommendation?: string;
  /** 7f: the merger's deduplicated comment list (Python draft['comments']). */
  metaComments: Record<string, unknown>[];
  /** copyedit-stage output: sanitized language-mechanics items. */
  copyeditItems?: CopyeditItem[];
}

/**
 * Sections worth challenging: (title, text) pairs. Mirrors Python
 * `_reviewable_sections`: falls back to a heading-heuristic split when
 * parsing produced no sections or a single degenerate one covering the whole
 * document (plain-text conversions, e5eedfa); then one big chunk.
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
  if (out.length <= 1) {
    const split = splitByHeadings(doc.fullText());
    if (split.length > out.length) return split;
  }
  if (out.length === 0) {
    out.push({ title: 'Full manuscript', text: doc.fullText() });
  }
  return out;
}

// -------------------------------------------- heading-heuristic fallback --
// Port of Python `_split_by_headings` (e5eedfa).

const FALLBACK_MD_RE = /^#{1,3}\s+(\S.*)$/; // markdown
const FALLBACK_NUM_RE = /^(?:\d{1,2}(?:\.\d+)*\.?|Appendix\s+[A-Z])\s+[A-Z].{2,120}$/; // numbered section lines
const FALLBACK_KW_RE =
  /^(?:abstract|references|bibliography|appendix|conclusions?)\s*$/i;
const FALLBACK_CAPS_RE = /^[A-Z][A-Z0-9 :&-]{3,60}$/;
const FALLBACK_MIN_CHARS = 400;
const FALLBACK_MAX_SECTIONS = 20;

/**
 * Split full text into (title, chunk) pairs when no sections were parsed.
 * Detects markdown headings, numbered section lines ('2.3 Methods'), keyword
 * headings (Abstract/References/...) and short ALL-CAPS title lines; skips
 * author-list style caps lines (commas, long). Chunks below the minimum
 * length merge into the previous section.
 */
export function splitByHeadings(text: string): { title: string; text: string }[] {
  const lines = text.split('\n');
  const boundaries: { line: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim();
    if (s.length < 3 || s.length > 130) continue;
    const md = FALLBACK_MD_RE.exec(s);
    if (md) {
      boundaries.push({ line: i, title: md[1]!.trim() });
      continue;
    }
    if (FALLBACK_NUM_RE.test(s)) {
      boundaries.push({ line: i, title: s });
      continue;
    }
    if (FALLBACK_KW_RE.test(s)) {
      boundaries.push({ line: i, title: titleCase(s) });
      continue;
    }
    if (FALLBACK_CAPS_RE.test(s) && !s.includes(',') && s.split(/\s+/).length <= 8) {
      boundaries.push({ line: i, title: s });
    }
  }
  if (boundaries.length === 0) return [];

  const chunks: string[][] = [];
  const titles: string[] = [];
  if (boundaries[0]!.line > 0) {
    chunks.push(lines.slice(0, boundaries[0]!.line));
    titles.push('Front matter');
  }
  for (let bi = 0; bi < boundaries.length; bi++) {
    const { line: start, title } = boundaries[bi]!;
    const end = bi + 1 < boundaries.length ? boundaries[bi + 1]!.line : lines.length;
    chunks.push(lines.slice(start, end));
    titles.push(title);
  }

  const out: { title: string; text: string }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!.join('\n').trim();
    if (!chunk) continue;
    if (chunk.length < FALLBACK_MIN_CHARS && out.length > 0) {
      const prev = out[out.length - 1]!;
      out[out.length - 1] = { title: prev.title, text: `${prev.text}\n\n${chunk}` };
    } else {
      out.push({ title: titles[i]!, text: chunk });
    }
  }
  while (out.length > FALLBACK_MAX_SECTIONS) {
    const last = out.pop()!;
    const prev = out[out.length - 1]!;
    out[out.length - 1] = { title: prev.title, text: `${prev.text}\n\n${last.text}` };
  }
  return out;
}

/** Python `s.title()` for the keyword-heading branch. */
function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

/** Python `_norm(t)[:120]`: normalized anchor prefix used for claim matching. */
function normPrefix(t: string): string {
  return normalizeText(t).toLowerCase().slice(0, 120);
}

/** Python `_similar_comments` (claims.py): title+message overlap >= 0.6 ratio. */
function similarComments(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ta = normalizeText(
    `${String(a['title'] ?? '')} ${String(a['message'] ?? '')}`,
  ).toLowerCase();
  const tb = normalizeText(
    `${String(b['title'] ?? '')} ${String(b['message'] ?? '')}`,
  ).toLowerCase();
  if (!ta || !tb) return false;
  return similarityRatio(ta, tb) >= 0.6;
}

/** Python `_meta` comments-listing cap (9a40f13): max(100_000, 900 * n). */
export function metaCommentsJsonCap(nComments: number): number {
  return Math.max(100_000, 900 * nComments);
}

/**
 * Python `_reattach_provenance` (9a40f13): deterministically re-attach
 * provenance that model re-emissions dropped. The meta merger and the
 * validator rebuild every comment dict per the JSON comment schema, which has
 * no provenance field — so multi-pass badges ("claim_verify 2-of-2") and the
 * deterministic/recompute tags never reached the report. Matching is
 * mechanical: exact normalized quote/anchor keys first, then the difflib
 * title+message similarity the claim engine already uses. Only fills gaps;
 * never overwrites.
 */
export function reattachProvenance(finalComments: unknown[], sources: unknown[]): void {
  const indexed = sources.filter(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' &&
      s !== null &&
      Boolean((s as Record<string, unknown>)['provenance']),
  );
  if (indexed.length === 0) return;
  const byQuote = new Map<string, string>();
  const byAnchor = new Map<string, string>();
  for (const s of indexed) {
    const q = normPrefix(String(s['quote'] ?? ''));
    const a = normPrefix(String(s['paragraph_anchor'] ?? ''));
    if (q && !byQuote.has(q)) byQuote.set(q, String(s['provenance']));
    if (a && !byAnchor.has(a)) byAnchor.set(a, String(s['provenance']));
  }
  for (const c of finalComments) {
    if (typeof c !== 'object' || c === null) continue;
    const co = c as Record<string, unknown>;
    if (co['provenance']) continue;
    const q = normPrefix(String(co['quote'] ?? ''));
    const a = normPrefix(String(co['paragraph_anchor'] ?? ''));
    if (q && byQuote.has(q)) {
      co['provenance'] = byQuote.get(q);
    } else if (a && byAnchor.has(a)) {
      co['provenance'] = byAnchor.get(a);
    } else {
      for (const s of indexed) {
        if (similarComments(co, s)) {
          co['provenance'] = String(s['provenance']);
          break;
        }
      }
    }
  }
}

/** Python `_anchor_in`: the anchor's first 120 normalized chars appear in text. */
function anchorIn(anchor: string, text: string): boolean {
  return normalizeText(text).toLowerCase().includes(normPrefix(anchor));
}

/** Python `_lenses_for`: verifier lens selection based on triage fields. */
export function lensesFor(
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
  if ((statContent !== '' && statContent !== 'none') || style.includes('empirical')) {
    // Stage 7f (449174c): statistical-rigor lens for empirical papers.
    lenses.push({ name: 'stats', system: statsVerifierSystem });
  }
  // literature coherence + clarity always run: cheap and central to the review
  lenses.push({ name: 'lit', system: litVerifierSystem });
  lenses.push({ name: 'clarity', system: clarityVerifierSystem });
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

/**
 * Python `_checker_comments`: deterministic checker findings as candidate
 * comments with provenance kept — mechanical findings skip the author-defense
 * gate. Severity clamped to [0.1, 0.95]; title/message/quote truncated.
 */
export function checkerComments(state: RunState): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const f of state.checkerFindings ?? []) {
    let sev = 0.5;
    const raw = f['severity'];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      sev = Math.min(0.95, Math.max(0.1, raw));
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) sev = Math.min(0.95, Math.max(0.1, parsed));
    }
    const quote = String(f['quote'] ?? '');
    out.push({
      section: '',
      quote: quote.slice(0, 240),
      comment: String(f['message'] ?? '').slice(0, 2500),
      severity: sev,
      paragraphAnchor: quote.slice(0, 400),
      category: String(f['category'] ?? 'consistency'),
      provenance:
        typeof f['provenance'] === 'string' ? f['provenance'] : 'deterministic',
      title: String(f['title'] ?? 'Finding').slice(0, 160),
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
    // COMMENT_SCHEMA demands a title in every response; keep it (7b renders
    // the header from it). Assemble still applies the Python fallback.
    title: typeof o['title'] === 'string' ? o['title'] : undefined,
  };
}

/** Python `_hit_to_item`: a web search hit becomes a web-source LiteratureItem. */
function hitToItem(
  hit: { title: string; url: string; snippet: string },
  why: string,
): LiteratureItem {
  return {
    source: 'web',
    title: hit.title,
    authors: [],
    doi: null,
    venue: null,
    citedBy: null,
    abstract: hit.snippet,
    url: hit.url,
    whyRelevant: why,
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
  const {
    doc: docOpt,
    settings: settingsOpt,
    providers: providersOpt,
    decider: deciderOpt,
    searchApiKeys: keysOpt,
    onEvent: eventsOpt,
    resume,
  } = opts;
  let doc = docOpt;
  let settings = settingsOpt;
  let providers = providersOpt;
  let decider = deciderOpt;
  const searchApiKeys = keysOpt;
  const onEvent = eventsOpt;
  const state: RunState =
    resume !== undefined ? resume.state : createRunState(newRunId(), doc.title);
  if (resume !== undefined) {
    // A resume re-enters with the SAVED document snapshot unless the caller
    // re-attached one (e.g. the UI re-ingesting the same file).
    if (!doc && resume.state.docData) {
      doc = documentFromData(resume.state.docData as DocumentData);
    }
    settings = resume.settings ?? settings;
    if (resume.providers) providers = resume.providers;
    if (resume.decider !== undefined) decider = resume.decider;
    // The resumed run re-derives partiality from its own stage outcomes —
    // an interruption or a pre-abort degradation must not poison it.
    resume.state.partial = false;
  }
  if (!doc || !settings || !providers) {
    throw new Error('runReview: doc, settings and providers are required');
  }
  const ledger = new UsageLedger(settings.maxCostUsd, settings.pricing);

  // ------------------------------------------------------- budget harness --
  // Python run() step 1b `_init_budget`: the harness owns planning + spend
  // tracking on top of the ledger. Preset tiers are uncapped (Python sets
  // the ledger cap to infinity; the TS ledger cap is the user's
  // maxCostUsd and the tier tracks estimate-only), 'auto' runs the
  // deterministic planner against settings.budget.budgetUsd.
  const tierRaw = (settings.budget?.depth ?? 'standard').toLowerCase().trim();
  const isAuto = tierRaw === 'auto';
  const planBudgetUsd = settings.budget?.budgetUsd ?? settings.maxCostUsd;
  const harness = new BudgetHarness(
    ledgerView(ledger, settings.pricing),
    {
      strong: {
        provider: settings.roles.strong.provider,
        model: settings.roles.strong.model,
      },
      small: {
        provider: settings.roles.small.provider,
        model: settings.roles.small.model,
      },
      ...(settings.roles.vision?.model
        ? {
            vision: {
              provider: settings.roles.vision.provider,
              model: settings.roles.vision.model,
            },
          }
        : {}),
      // Stage 7e: the decision role is OPTIONAL (eaa1a85) — when its provider
      // + model are bound, dm_* cost entries become priced and the committee
      // wakes up; when absent the harness specs carry no 'decision' key and
      // every DM unit costs 0 (the dormant, byte-identical pre-7e behavior).
      ...(settings.decisionRole?.provider && settings.decisionRole?.model
        ? {
            decision: {
              provider: settings.decisionRole.provider,
              model: settings.decisionRole.model,
            },
          }
        : {}),
    },
    planBudgetUsd,
    isAuto,
  );
  // Python _load_or_create_state resume: restore done-call counters + spend
  // accounting from the persisted ledger records BEFORE any new call. The
  // records go to the harness AND the fresh ledger (Python restores
  // pool.ledger.calls) so actual_cost/projected_final keep the pre-drain
  // spend after a top-up, and syncBudgetToState re-persists them.
  for (const rec of state.ledgerCalls ?? []) {
    harness.note_record(rec);
    ledger.restore([
      {
        model: String(rec.model ?? ''),
        role: String(rec.role ?? ''),
        usage: {
          promptTokens: Number(rec.inputTokens ?? 0),
          completionTokens: Number(rec.outputTokens ?? 0),
        },
        costUsd: Number(rec.costUsd ?? 0),
        callType: String(rec.callType ?? 'other'),
      },
    ]);
  }
  if (state.plan) {
    // A raised budget resumes with the restored plan at the NEW ceiling.
    harness.set_plan(
      { ...(state.plan as ReviewPlan), budget_usd: planBudgetUsd },
      'restored-resume',
    );
  }
  /** Per-call projected cost (Python ledger.check_budget). */
  const projectedCallCost = (role: Role, system: string, user: string): number => {
    const s = specOf(settings, role);
    const pricing = settings.pricing[s.model];
    const estIn = (system.length + user.length) / CHARS_PER_TOKEN;
    const estOut = Math.min(s.maxTokens, Math.max(1000, estIn / 4));
    return pricing ? (estIn * pricing.input + estOut * pricing.output) / 1_000_000 : 0;
  };

  // Persist the doc snapshot at run start: a budget drain (or any early
  // exit) before the first syncArtifacts must still leave the run
  // resumable — the doc snapshot is what the UI resume flow re-attaches.
  state.docData = documentToData(doc);

  await saveRun(state);

  /**
   * The stage sequence. Unexpected exceptions (IndexedDB failure in emit, a
   * non-LLMError throw from a provider) propagate to the driver below, which
   * fails the run persistently before rethrowing — a run must never stay in
   * 'running' forever.
   */
  const pipeline = async function* (): AsyncGenerator<StageEvent, void, undefined> {
    const savedA = (state.artifacts ?? {}) as Partial<StageArtifacts>;
    const artifacts: Artifacts = {
      claims: [],
      candidates: [],
      overall: '',
      metaComments: [],
      ...(state.artifacts as Partial<Artifacts> | undefined),
    };
    // draftReview is stored under its own key (Python draft_review); fold it
    // back into the in-memory meta slots.
    if (artifacts.overall === '' && savedA.draftReview) {
      artifacts.overall = savedA.draftReview.overall;
      artifacts.recommendation = savedA.draftReview.recommendation;
    }
    // ed1d8da: resumed runs load stage artifacts as JSON — rebuild the
    // ContextPack from its persisted artifact so every consumer (scout's
    // items.extend, renderPack, meta's field_hint) sees a validated pack
    // with all fields round-tripped.
    if (artifacts.survey !== undefined) {
      const rebuilt = contextPackFromArtifact(artifacts.survey);
      if (rebuilt) artifacts.survey = rebuilt;
    }
    state.artifacts = {
      triage: artifacts.triage,
      claims: artifacts.claims,
      survey: artifacts.survey,
      candidates: artifacts.candidates,
      challenge: artifacts.challenge,
      bibliography: artifacts.bibliography,
      draftReview:
        artifacts.overall !== ''
          ? {
              overall: artifacts.overall,
              recommendation: artifacts.recommendation,
            }
          : undefined,
      copyeditItems: artifacts.copyeditItems,
    };
    let budgetError: BudgetExceeded | undefined;
    // Python plan_knobs(): harness plan when present, else the tier preset.
    // 7c closes the old divergence: the tier now FEEDS the preset, user
    // overrides still win (depthPresetFromTier).
    const tierPreset = planKnobsFromPreset(
      (() => {
        const p = depthPresetFromTier(settings);
        return {
          max_claims: p.maxClaims,
          per_section_lenses: p.perSectionLenses,
          whole_paper_passes: p.wholePaperPasses,
          defense_round: p.defenseRound,
          max_artifacts: p.maxArtifacts,
          recompute: p.recompute,
          verify_passes: p.verifyPasses,
          claim_routing: p.claimRouting,
          output_budget: p.outputBudget,
          synthesis: p.synthesis,
          copyedit: p.copyedit,
          defense_second_round: p.defenseSecondRound,
        };
      })(),
    );
    let planKnobs: PlanKnobs = tierPreset;
    if (isAuto) {
      // Python _init_budget auto branch: deterministic preflight plan (free).
      // Doc stats first (the dominant cost driver).
      harness.stats = documentStatsFromDoc(doc);
      if (harness.plan === undefined) {
        try {
          harness.require_pricing();
          const plan = harness.deterministic_plan('preflight');
          harness.set_plan(plan, 'preflight-v0');
        } catch (err) {
          if (err instanceof BudgetInfeasible) {
            // Python raises before any model call; surface as a failed run.
            throw err;
          }
          // PricingError degrades to preset tracking in Python only for
          // preset modes; auto mode re-raises. Keep parity: rethrow.
          throw err;
        }
      }
      planKnobs = harness.plan?.knobs ?? tierPreset;
    } else if (harness.plan === undefined) {
      // Preset mode: estimate-only tracking plan (uncapped by design).
      harness.stats = documentStatsFromDoc(doc);
      harness.set_plan(harness.preset_plan(tierPreset, tierRaw), 'preset-tracking');
    }
    /** challenge-stage output (validated + new_comments), feeding meta. */
    const challengeValidated: ReviewComment[] = artifacts.challenge ?? [];
    /**
     * Python `self._claims_ranked` (7e review B2): true when the committee's
     * decision model already importance-ranked the claims — verifyClaims must
     * then keep that order instead of re-sorting by coarse importance.
     */
    let claimsRanked = false;
    /**
     * 7e review (B4): set when NO continuation plan is feasible (Python
     * wrapup_incomplete would raise ReviewIncomplete). The stage walk then
     * skips every remaining LLM-consuming stage directly to the partial
     * assemble — the shortfall is recorded on the run state.
     */
    let noContinuation = false;
    /**
     * Deterministic checker comments (Python `_checker_comments`), consumed
     * at assemble ONLY (e2ba304) — and at a mid-verify wrap-up, whose partial
     * assemble mirrors the tail. LAZY: findings are populated inside verify,
     * so the accessor must be called at assemble time, not before.
     */
    const checker = () => checkerComments(state);
    /** Stage order for the wrap-up partial trail (same as the drain's). */
    const WRAP_ORDER: Stage[] = [
      'claims',
      'survey',
      'scout',
      'verify',
      'challenge',
      'bibliography',
      'meta',
      'validate',
      'copyedit',
    ];

    // Python run() step 1 (post-ingest): extract theorem environments and
    // markdown-table artifacts — deterministic, free, and required by the
    // 7b checkers (xref definitions come from doc.theorems; table arithmetic
    // reads doc.tables). Python appends extract_tables AFTER reader tables;
    // match that order and only fill when absent (a resume re-entering with
    // a persisted docData snapshot must not duplicate artifacts).
    if (doc.theorems.length === 0) doc.theorems = extractTheorems(doc);
    if (doc.tables.length === 0) doc.tables = extractTables(doc);

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

    /**
     * Python `_sync_budget_to_state`: persist plan + ledger records so a
     * resumed run keeps its spend accounting and a raised budget (top-up)
     * continues from the failure point.
     */
    function syncBudgetToState(): void {
      state.plan = harness.plan ? JSON.parse(JSON.stringify(harness.plan)) : undefined;
      state.ledgerCalls = ledger.calls.map((c) => ({
        model: c.model,
        role: c.role,
        callType: c.callType,
        inputTokens: c.usage.promptTokens,
        outputTokens: c.usage.completionTokens,
        costUsd: c.costUsd,
      }));
    }

    // -------------------------------------------------- decision funnel --
    // Python RolePool.decide: a decision call is a model call like any other
    // — budget-checked against the ledger cap, recorded under its dm_* call
    // type, and fed to the harness. Without a decider the funnel returns
    // undefined and every consumer keeps its labelled fallback (eaa1a85).

    /** Committee deps view over the orchestrator closures (7e). */
    const committeeEmit = async (
      message: string,
      detail?: Record<string, unknown>,
    ): Promise<void> => {
      // Committee/replan announcements ride the challenge stage's running
      // channel (Python emits them under Stage.PLAN, which the TS pipeline
      // folds into the driving stage) — telemetry only, never a stage state.
      await emit('challenge', 'running', message);
      void detail;
    };

    const decide: DecisionCaller | undefined = decider
      ? async (input, questions, callType) => {
          // Python: est_in = max(1, len(input) // 3); est_out = 1.
          const estIn = Math.max(1, Math.floor(input.length / 3));
          // Defensive read (7e review B6): a hand-edited settings object can
          // carry a decider without the decisionRole block — treat a missing
          // block/pricing entry as zero pricing instead of crashing.
          const dr = settings.decisionRole;
          const pricing = dr ? settings.pricing[dr.model] : undefined;
          const projected = pricing
            ? (estIn * pricing.input + 1 * pricing.output) / 1_000_000
            : 0;
          try {
            ledger.checkBudget(projected);
          } catch {
            return undefined; // the DM layer degrades like any gated call
          }
          const result = await decider(input, questions, callType);
          if (result === undefined) return undefined;
          const model = dr?.model ?? '';
          const rec = ledger.record(
            model,
            'decision',
            { content: '', usage: result.usage, model },
            callType,
          );
          harness.note_record({
            callType: rec.callType,
            inputTokens: rec.usage.promptTokens,
            outputTokens: rec.usage.completionTokens,
            costUsd: rec.costUsd,
          });
          return result;
        }
      : undefined;

    /** Python `_dm_triage_classification`: closed-set triage classification. */
    async function dmTriageClassification(
      doc_: Document,
    ): Promise<Record<string, unknown>> {
      if (decide === undefined) return {};
      const abstract = doc_.fullText().slice(0, 8000);
      const questions: DecisionQuestion[] = [
        {
          type: 'choice',
          name: 'paper_type',
          instructions: "The manuscript's dominant type.",
          choices: ['theory', 'empirical', 'mixed', 'survey', 'other'].map((v) => ({
            value: v,
          })),
        },
        {
          type: 'score',
          name: 'mathematical_density',
          instructions:
            'Density of formal mathematics (theorems, proofs, derivations).',
          levels: ['none', 'light', 'moderate', 'heavy'].map((v) => ({ label: v })),
        },
        {
          type: 'choice',
          name: 'statistical_content',
          instructions: 'The kind of statistical/econometric content.',
          choices: ['none', 'descriptive', 'inferential', 'causal', 'forecasting'].map(
            (v) => ({ value: v }),
          ),
        },
        {
          type: 'choice',
          name: 'methodological_style',
          instructions: 'The dominant methodological style.',
          choices: [
            'analytical-theory',
            'econometrics',
            'machine-learning',
            'simulation',
            'mixed',
          ].map((v) => ({ value: v })),
        },
      ];
      let result;
      try {
        result = await decide(
          `Manuscript: ${doc_.title}\n\n${abstract}`,
          questions,
          'dm_triage',
        );
      } catch {
        return {};
      }
      if (result === undefined) return {};
      const out: Record<string, unknown> = {};
      let a = answer(result, 'paper_type');
      if (a?.choice) out['paper_type'] = a.choice;
      a = answer(result, 'mathematical_density');
      if (a !== undefined && a.probabilities.length > 0) {
        // score level index -> label with the highest probability
        let best: Record<string, unknown> | undefined;
        for (const p of a.probabilities) {
          if (
            best === undefined ||
            Number(p['probability'] ?? 0) > Number(best['probability'] ?? 0)
          ) {
            best = p;
          }
        }
        const v = best?.['value'];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 4) {
          out['mathematical_density'] = (
            ['none', 'light', 'moderate', 'heavy'] as const
          )[v];
        }
      }
      for (const name of ['statistical_content', 'methodological_style']) {
        const ans = answer(result, name);
        if (ans?.choice) out[name] = ans.choice;
      }
      return out;
    }

    /**
     * Python survey-stage DM relevance filter: batched predicates over the
     * first 40 pack items; low-probability items are dropped before the
     * surveyor reads the pack.
     */
    async function dmSurveyFilter(
      triage: Record<string, unknown>,
      pack: ContextPack,
    ): Promise<void> {
      if (decide === undefined || pack.items.length === 0) return;
      const head = pack.items.slice(0, 40);
      const qItems = head
        .map(
          (it, i) =>
            `${i + 1}. ${it.title.slice(0, 120)} — ${(it.whyRelevant ?? '').slice(0, 80)}`,
        )
        .join('\n');
      const qs: DecisionQuestion[] = head.map((_it, i) => ({
        type: 'predicate',
        name: `item_${i + 1}`,
        instructions:
          `Literature item ${i + 1} is relevant background for reviewing a ` +
          'manuscript in this field and should be kept in the context pack.',
      }));
      try {
        const dm = await decide(
          `Field: ${String(triage['domain'] ?? 'unknown')}\n\nItems:\n${qItems}`,
          qs,
          'dm_survey',
        );
        if (dm === undefined) return;
        const kept: LiteratureItem[] = [];
        for (let i = 0; i < head.length; i++) {
          const a = answer(dm, `item_${i + 1}`);
          if (a === undefined || a.probability === undefined || a.probability >= 0.5) {
            kept.push(head[i]!);
          }
        }
        const dropped = pack.items.length - kept.length;
        pack.items = [...kept, ...pack.items.slice(40)];
        if (dropped > 0) {
          await emit(
            'survey',
            'running',
            `decision filter dropped ${dropped} irrelevant literature items`,
          );
        }
      } catch {
        // DM survey filter failed: keeping all items (Python logs + continues)
      }
    }

    /**
     * Python `_dm_validator_gate`: batched grounding predicates (60 per
     * decide call) over the meta draft's comments before the validator.
     */
    async function dmValidatorGate(
      doc_: Document,
      comments: Record<string, unknown>[],
      manuscript_: string,
    ): Promise<Record<string, unknown>[]> {
      if (decide === undefined || comments.length === 0) return comments;
      const kept: Record<string, unknown>[] = [];
      let dropped = 0;
      for (let lo = 0; lo < comments.length; lo += 60) {
        const chunk = comments.slice(lo, lo + 60);
        const listing = chunk
          .map(
            (c, i) =>
              `${i + 1}. [${String(c['title'] ?? '').slice(0, 60)}] quote=${String(
                c['quote'] ?? '',
              ).slice(
                0,
                100,
              )} anchor=${String(c['paragraph_anchor'] ?? '').slice(0, 80)}`,
          )
          .join('\n');
        const qs: DecisionQuestion[] = chunk.map((_c, i) => ({
          type: 'predicate',
          name: `comment_${i + 1}`,
          instructions:
            `Review comment ${i + 1} quotes or paraphrases text that actually ` +
            'appears in the manuscript text provided above (not invented) — ' +
            'check the quote/anchor against that text.',
        }));
        let dm: DecisionResult | undefined;
        try {
          dm = await decide(
            `Manuscript: ${doc_.title}\n\nManuscript text:\n---\n${manuscript_}\n---\n\nComments:\n${listing}`,
            qs,
            'dm_validate',
          );
        } catch {
          dm = undefined;
        }
        if (dm === undefined) {
          kept.push(...chunk);
          continue;
        }
        for (let i = 0; i < chunk.length; i++) {
          const a = answer(dm, `comment_${i + 1}`);
          if (a === undefined || a.probability === undefined || a.probability >= 0.5) {
            kept.push(chunk[i]!);
          } else {
            dropped += 1;
          }
        }
      }
      if (dropped > 0) {
        await emit(
          'validate',
          'running',
          `decision gate dropped ${dropped} ungrounded comments before validation`,
        );
      }
      return kept;
    }

    /**
     * Python `_replan_checkpoint`: telemetry when on-plan; when the harness
     * flags a deviation (or a spike), rebuild the residual frontier and let
     * the committee pick a continuation; when NOTHING is feasible, wrap up.
     */
    async function* replanCheckpoint(
      where: string,
    ): AsyncGenerator<StageEvent, void, undefined> {
      if (harness.plan === undefined) return;
      const reason = harness.should_replan();
      const st = harness.status();
      if (reason === null) {
        yield* emit(
          'triage',
          'running',
          `budget after ${where}: $${Number(st['actual_usd']).toFixed(2)} spent, ` +
            `$${Number(st['projected_final_usd']).toFixed(2)} projected of ` +
            `$${Number(st['budget_usd']).toFixed(2)}`,
        );
        syncBudgetToState();
        return;
      }
      const applied = await replanChoice(
        {
          callJson: async (role, system, user, opts) =>
            callJson(role, system, user, opts),
          decide,
          harness,
          emit: committeeEmit,
          triage: artifacts.triage ?? {},
          syncBudgetToState,
        },
        reason,
      );
      if (!applied) {
        // 7e review (B4): Python calls `committee.wrapup_incomplete(self,
        // pool, reason)` — synthesize the best-possible report, record the
        // estimated shortfall on the run state (state.shortfall_usd) and
        // return the wrap-up report through ReviewIncomplete. The TS
        // pipeline keeps its resumable top-up contract (the drain clears the
        // persisted report) but must still produce the wrap-up synthesis ONCE
        // for the run, not per checkpoint — Python's first wrap-up raises
        // ReviewIncomplete, which terminates the stage walk immediately.
        // Gate: only the whole-stage 'verify'/'challenge' checkpoints wrap up
        // (the sub-stage ones per-call-gate onward, matching upstream where
        // the first infeasible checkpoint ends the run).
        state.partial = true;
        state.shortfallUsd = harness.shortfall();
        syncBudgetToState();
        await saveRun(state);
        yield* emit(
          'challenge',
          'running',
          `no feasible continuation (${reason}); wrapping up with a partial report — ` +
            `est. +$${(state.shortfallUsd ?? 0).toFixed(2)} needed`,
        );
        noContinuation = true;
      }
    }

    /** Persist the per-stage artifact map + doc snapshot + budget state. */
    async function syncArtifacts(): Promise<void> {
      state.artifacts = {
        triage: artifacts.triage,
        claims: artifacts.claims,
        survey: artifacts.survey,
        // Python artifacts['candidates'] / ['draft_review'] parity.
        candidates: artifacts.candidates,
        challenge: artifacts.challenge,
        bibliography: artifacts.bibliography,
        draftReview:
          artifacts.overall !== ''
            ? {
                overall: artifacts.overall,
                recommendation: artifacts.recommendation,
              }
            : undefined,
        copyeditItems: artifacts.copyeditItems,
      };
      state.docData = documentToData(doc!);
      syncBudgetToState();
      await saveRun(state);
    }

    /**
     * Python `_synthesis` (449174c): the lead-referee essay pass over the
     * meta merger's deduplicated comments. Emits one strong call tagged
     * `synthesis`, priced and output-budgeted via callMaxTokens; returns
     * undefined when the essay is missing/empty (the caller keeps the
     * merger's overall — the pass is fail-soft, never fails the stage).
     */
    async function runSynthesis(
      bib: BibliographyAudit,
    ): Promise<string | BudgetExceeded | undefined> {
      const comments = artifacts.metaComments;
      const listing = comments
        .slice(0, 120)
        .map((c) => {
          const rawScore = c['score'];
          const score =
            typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 0;
          const prov = c['provenance'];
          return (
            `- [${score.toFixed(2)}] ` +
            `(${typeof prov === 'string' && prov !== '' ? prov : 'llm'}) ` +
            `${String(c['title'] ?? '').slice(0, 110)} :: ` +
            `${String(c['paragraph_anchor'] ?? '').slice(0, 80)}`
          );
        })
        .join('\n');
      const bibSummary = JSON.stringify({
        entries: bib.entries
          .filter(
            (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
          )
          .slice(0, 40)
          .map((e) => ({ raw: e['raw_entry'] ?? '', status: e['status'] ?? '' })),
        in_text_issues: bib.in_text_issues.slice(0, 20),
      }).slice(0, 8000);
      const res = await callJson(
        'strong',
        synthesisSystem,
        synthesisPrompt(
          doc.title,
          JSON.stringify(artifacts.triage ?? {}).slice(0, 3000),
          // Python: listing or "(no validated comments)"
          listing || '(no validated comments)',
          bibSummary,
          (artifacts.survey?.fieldHint ?? '').slice(0, 1500),
          // Python: venue_block formatted at the tail of SYNTHESIS_USER. The
          // TS pipeline has no venue block yet; the slot renders ''.
          '',
        ),
        {
          callType: 'synthesis',
          maxTokens: callMaxTokens('synthesis', planKnobs.output_budget),
        },
      );
      if (res.kind === 'budget') {
        // 7f review (D3): Python lets BudgetExceeded drain through its run()
        // handler (partial report, budgetError set, validate skipped) — the
        // synthesis result must PROPAGATE, not degrade to the merger's own
        // overall. Surfaced to the caller (the meta block assigns the global
        // budgetError); the essay call result itself is a clean empty reply.
        return res.error;
      }
      if (res.kind !== 'ok') {
        console.warn(
          `synthesis pass degraded: ${
            res.kind === 'llm_error'
              ? res.error.message
              : 'invalid JSON in model response'
          }`,
        );
        return undefined;
      }
      const o = (res.value ?? {}) as Record<string, unknown>;
      const essay =
        typeof o['overall_feedback'] === 'string' ? o['overall_feedback'].trim() : '';
      return essay === '' ? undefined : essay;
    }

    /** Python `_stage_or_resume` gate: skip a stage whose artifact survived. */
    function skipIfDone(stage: Stage): boolean {
      if (resume === undefined) return false;
      const a = state.artifacts ?? {};
      const doneWithArtifact =
        stageStatus(state, stage) === 'done' &&
        (stage === 'triage'
          ? a.triage !== undefined
          : stage === 'claims'
            ? a.claims !== undefined
            : stage === 'survey'
              ? a.survey !== undefined
              : stage === 'challenge'
                ? a.challenge !== undefined
                : stage === 'bibliography'
                  ? a.bibliography !== undefined
                  : stage === 'copyedit'
                    ? a.copyeditItems !== undefined
                    : true);
      return (
        doneWithArtifact ||
        (stageStatus(state, stage) === 'skipped' && state.report !== undefined)
      );
    }

    /**
     * One budget-checked, usage-recorded, JSON-parsed completion.
     * `callType` keys the budget harness's per-phase accounting (Python
     * complete_json(call_type=...)); `maxTokens` overrides the role default
     * per call (Python complete_json(max_tokens=...), Stage 7c meta scaling).
     *
     * Stage 7d (Python complete_json two-phase logic, 1515a7d + 8a8bb77 +
     * bfd2cdb): reasoning models can exhaust the output budget thinking
     * before any JSON is emitted (empty content, completion ≈ cap). The
     * escalation ladder — gated on the provider's supportsReasoning flag so
     * non-reasoning stubs keep their exact call sequences — is:
     *   single call -> same call under the low-effort control (cheap,
     *   seconds) -> full two-phase (free-form reasoning at
     *   jsonPhaseMaxTokens, then low-effort JSON emission fed the analysis)
     *   -> parse-repair retry. Every phase books its ledger record under the
     *   original call type so cost models self-calibrate.
     */
    async function callJson(
      role: Role,
      system: string,
      user: string,
      opts?: { callType?: string; maxTokens?: number },
    ): Promise<CallResult> {
      const callType = opts?.callType ?? 'other';
      const s = {
        ...specOf(settings, role),
        ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      };
      // Budget check BEFORE the call; unpriced models project 0.
      const projected = projectedCallCost(role, system, user);
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
      const provider = providers[role];
      let resp;
      try {
        resp = await provider.complete(messages, s);
      } catch (err) {
        if (err instanceof LLMError) return { kind: 'llm_error', error: err };
        throw err;
      }
      const rec = ledger.record(s.model, role, resp, callType);
      // Python RolePool feeds every booked record to the harness (empirical
      // unit costs + done counters + spike detection live there).
      harness.note_record({
        callType: rec.callType,
        inputTokens: rec.usage.promptTokens,
        outputTokens: rec.usage.completionTokens,
        costUsd: rec.costUsd,
      });
      if (resp.content.trim() !== '') {
        try {
          return { kind: 'ok', value: extractJson(resp.content) };
        } catch {
          // non-empty but unparseable: Python skips the escalation ladder and
          // goes straight to the repair replay below.
        }
      }
      // Exhaustion signature: empty content (reasoning ate the budget). The
      // whole escalation ladder is gated on the provider's supportsReasoning
      // flag so non-reasoning stubs keep their exact call sequences (e2e
      // queues stable); Python gates on the exhaustion signature alone.
      if (resp.content.trim() === '' && provider.supportsReasoning) {
        // Cheap escalation first: the same call under the low-effort control
        // (survey + live probes: reasoning spiral short-circuits, valid JSON
        // in seconds) before the expensive free-form phase (bfd2cdb).
        const emissionEffort = 'low';
        const lowSpec: ModelSpec = { ...s, reasoningEffort: emissionEffort };
        let respLow;
        try {
          respLow = await provider.complete(messages, lowSpec);
        } catch (err) {
          if (err instanceof LLMError) return { kind: 'llm_error', error: err };
          throw err;
        }
        const recLow = ledger.record(lowSpec.model, role, respLow, callType);
        harness.note_record({
          callType: recLow.callType,
          inputTokens: recLow.usage.promptTokens,
          outputTokens: recLow.usage.completionTokens,
          costUsd: recLow.costUsd,
        });
        if (respLow.content.trim() !== '') {
          try {
            return { kind: 'ok', value: extractJson(respLow.content) };
          } catch {
            // fall through to the full two-phase attempt
          }
        }
        // Full two-phase (1515a7d + 8a8bb77): phase 1 free-form reasoning at
        // the raised 24k budget (json pressure off), phase 2 low-effort JSON
        // emission fed the phase-1 analysis (last 8k chars).
        const phase1 = await twoPhaseReasoning(
          provider,
          s,
          role,
          system,
          user,
          callType,
          emissionEffort,
        );
        if (phase1 !== undefined) return phase1;
      }
      // Parse-repair retry (Python RolePool.complete_json tail): one replay
      // with the repair suffix. On the FIRST call's raw reply if it was
      // non-empty (Python: extract_json(resp.text) once more), else straight
      // to the replay.
      if (resp.content.trim() !== '') {
        try {
          return { kind: 'ok', value: extractJson(resp.content) };
        } catch {
          // continue to the repair replay
        }
      }
      const repairUser = `${user}\n\nYour previous reply was not valid JSON. Reply again with ONLY the required JSON object, no prose, no code fences.`;
      const repairMessages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: repairUser },
      ];
      let resp2;
      try {
        resp2 = await provider.complete(repairMessages, s);
      } catch (err) {
        if (err instanceof LLMError) return { kind: 'llm_error', error: err };
        throw err;
      }
      const rec2 = ledger.record(s.model, role, resp2, callType);
      harness.note_record({
        callType: rec2.callType,
        inputTokens: rec2.usage.promptTokens,
        outputTokens: rec2.usage.completionTokens,
        costUsd: rec2.costUsd,
      });
      try {
        return { kind: 'ok', value: extractJson(resp2.content) };
      } catch {
        // never leak a raw decode error: stages catch LLMError and degrade
        // gracefully instead of failing the whole run (c628796).
        return {
          kind: 'llm_error',
          error: new LLMError(
            `${s.provider}/${s.model} returned no parseable JSON even after a repair attempt (last reply started: ${JSON.stringify(resp2.content.slice(0, 120))})`,
          ),
        };
      }
    }

    /**
     * Python `_two_phase_json`: phase 1 free-form reasoning (json_mode off,
     * max(callMaxTokens 24k, spec.maxTokens) budget), phase 2 low-effort
     * emission with the analysis in context. Returns undefined when phase 1
     * produced no analysis or the emission failed to parse (caller falls
     * back to the single-call repair ladder). Both calls ledger-booked under
     * the original call type.
     */
    async function twoPhaseReasoning(
      provider: ChatProvider,
      s: ModelSpec,
      role: Role,
      system: string,
      user: string,
      callType: string,
      emissionEffort: string,
    ): Promise<CallResult | undefined> {
      // Python: p1_budget = max(int(cfg.llm.json_phase_max_tokens), spec.max_tokens)
      // 8a8bb77 raised the default to 24576 (16k exhausted phase 1 as well).
      const p1Budget = Math.max(24_576, s.maxTokens);
      const p1Spec: ModelSpec = {
        ...s,
        callMaxTokens: p1Budget,
        maxTokens: Math.max(p1Budget, s.maxTokens),
      };
      const phaseMessages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      let resp1;
      try {
        resp1 = await provider.complete(phaseMessages, p1Spec);
      } catch (err) {
        // 7d review (C2): Python wraps phase 1 in try/except LLMError (logs +
        // falls to the repair replay) — return undefined, not llm_error.
        if (err instanceof LLMError) return undefined;
        throw err;
      }
      const rec1 = ledger.record(p1Spec.model, role, resp1, callType);
      harness.note_record({
        callType: rec1.callType,
        inputTokens: rec1.usage.promptTokens,
        outputTokens: rec1.usage.completionTokens,
        costUsd: rec1.costUsd,
      });
      const analysis = resp1.content.trim();
      if (!analysis) return undefined;
      const emitSystem = `${system}\n\nYou are given your own prior analysis of the task. Output ONLY the required JSON object now — no prose, no code fences, no reasoning.`;
      const emitUser = `Your prior analysis:\n----\n${analysis.slice(-8000)}\n----\n\n${user}\n\nBased on the analysis above, output ONLY the required JSON now.`;
      const emitSpec: ModelSpec = { ...s, reasoningEffort: emissionEffort };
      let resp2;
      try {
        resp2 = await provider.complete(
          [
            { role: 'system', content: emitSystem },
            { role: 'user', content: emitUser },
          ],
          emitSpec,
        );
      } catch (err) {
        // 7d review (C2): Python's except LLMError falls to the repair replay
        // — return undefined, not llm_error.
        if (err instanceof LLMError) return undefined;
        throw err;
      }
      const rec2 = ledger.record(emitSpec.model, role, resp2, callType);
      harness.note_record({
        callType: rec2.callType,
        inputTokens: rec2.usage.promptTokens,
        outputTokens: rec2.usage.completionTokens,
        costUsd: rec2.costUsd,
      });
      try {
        return { kind: 'ok', value: extractJson(resp2.content) };
      } catch {
        return undefined; // fall through to the repair ladder
      }
    }

    /** Settle a stage result; true when the pipeline should keep going. */
    async function* settle(
      stage: Stage,
      result: CallResult,
      onOk: (value: unknown) => void | Promise<void>,
      progress?: StageProgress,
    ): AsyncGenerator<StageEvent, boolean, undefined> {
      if (result.kind === 'ok') {
        await onOk(result.value);
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
    // Python `_triage`: the DM closed-set classification half runs FIRST and
    // its result is (a) injected into the LLM user prompt as given and
    // (b) merged over the LLM reply (DM wins shared keys). Dormant without a
    // decider — the LLM prompt byte-stream is unchanged pre-7e.
    let dmClass: Record<string, unknown> = {};
    if (!skipIfDone('triage')) {
      yield* emit('triage', 'running');
      dmClass = await dmTriageClassification(doc);
      let triageUser = triagePrompt(doc.title, manuscript);
      if (Object.keys(dmClass).length > 0) {
        triageUser +=
          '\n\n## Classification already determined (use as given)\n\n' +
          JSON.stringify(dmClass) +
          '\nFocus your reply on domain, search queries, key citations, main claims.\n';
      }
      const triageRes = await callJson('strong', triageSystem, triageUser, {
        callType: 'triage',
      });
      {
        const keep = yield* settle('triage', triageRes, async (v) => {
          artifacts.triage = (v ?? {}) as Record<string, unknown>;
          // Python `_triage` tail: the exact lens count feeds the harness
          // stats (7f review D1 — the count varies 3-6 with the triage).
          harness.stats = {
            ...harness.stats,
            n_lenses: lensesFor(artifacts.triage ?? {}).length,
          };
          await syncArtifacts();
        });
        if (!keep) {
          budgetError = triageRes.kind === 'budget' ? triageRes.error : undefined;
        }
      }
      // DM classification wins on shared keys (Python triage.update(dm_class)).
      if (Object.keys(dmClass).length > 0 && artifacts.triage !== undefined) {
        artifacts.triage = { ...artifacts.triage, ...dmClass };
        await syncArtifacts();
      }
    }

    // ------------------------------------------------------------ 1b. claims --
    if (!budgetError && !noContinuation && !skipIfDone('claims')) {
      yield* emit('claims', 'running');
      const claimJson: CallJson = (role, system, user) => callJson(role, system, user);
      const inv = await runClaimInventory({
        callJson: claimJson,
        doc,
        triage: artifacts.triage ?? {},
        settings,
      });
      if (inv.budget) budgetError = inv.budget;
      // Python: the exact claim count is the dominant cost driver — it is
      // recorded on the harness stats as a milestone BEFORE ranking and the
      // committee (committee planning reads it via known_or_estimated_claims).
      harness.stats = { ...harness.stats, n_claims: inv.claims.length };
      // claims are importance-ranked (decision model when available), then — in AUTO
      // mode — the committee commits a frontier path for the run.
      claimsRanked = false;
      if (decide !== undefined && inv.claims.length > 0 && isAuto) {
        try {
          inv.claims = await rankClaims(
            {
              callJson: async (role, system, user, opts) =>
                callJson(role, system, user, opts),
              decide,
              harness,
              emit: committeeEmit,
              triage: artifacts.triage ?? {},
              syncBudgetToState,
            },
            inv.claims,
          );
          // Python `self._claims_ranked = True`: verifyClaims must keep the
          // committee's order (no importance re-sort).
          claimsRanked = true;
        } catch {
          // ranking degraded to inventory order inside rankClaims
        }
      }
      artifacts.claims = inv.claims;
      await syncArtifacts();
      if (budgetError) {
        yield* emit('claims', 'failed', `budget cap reached: ${budgetError.message}`);
      } else if (inv.claims.length > 0) {
        yield* emit('claims', 'done', `${inv.claims.length} claims catalogued`);
        // AUTO committee: reflect -> choose -> confirm (7e). Dormant without
        // a decider OR outside auto mode (Python _is_auto gate).
        if (isAuto) {
          try {
            const committed = await strategyCommittee(
              {
                callJson: async (role, system, user, opts) =>
                  callJson(role, system, user, opts),
                decide,
                harness,
                emit: committeeEmit,
                triage: artifacts.triage ?? {},
                syncBudgetToState,
              },
              inv.claims,
            );
            planKnobs = harness.plan?.knobs ?? planKnobs;
            yield* emit(
              'claims',
              'running',
              `committee committed frontier path '${committed.path.name}'`,
            );
          } catch (err) {
            if (err instanceof BudgetInfeasible) {
              // Python strategy_committee lets BudgetInfeasible propagate and
              // fail the run before any review spend. The TS e2e budget-gate
              // scenario (restored million-dollar records from a drained
              // preset attempt, 7c) hits the same infeasibility through the
              // committee instead of the preflight planner; degrade to the
              // per-call gating + cap drain path rather than discarding the
              // in-flight run (the TS pipeline never discards its work).
              state.partial = true;
              syncBudgetToState();
              await saveRun(state);
              yield* emit(
                'claims',
                'running',
                'no feasible frontier path; budget gating takes over',
              );
            } else {
              // reflection/committee failure: the preflight plan stays in charge
            }
          }
        }
      } else {
        // Python logs a warning and continues claimless.
        state.partial = true;
        await saveRun(state);
        yield* emit('claims', 'failed', 'claim inventory failed or produced no claims');
      }
    }

    // ------------------------------------------------------------ 2. survey --
    // Python `_literature`: OpenAlex per triage search query until 30 items,
    // web-router context (recent / non-scholarly), dedupe by normalized title,
    // then the SMALL surveyor refines why_relevant and surfaces missing
    // references (Crossref lookups). Literature enrichment is best-effort:
    // network failures degrade to console.warn, but LLMError/BudgetExceeded
    // from the surveyor call DO propagate (fail the stage / drain budget).
    // if (state.report !== undefined) — a skipped stage stays skipped only
    // when the run drained to a report; otherwise the run died mid-drain.
    if (!budgetError && !noContinuation && !skipIfDone('survey')) {
      yield* emit('survey', 'running');
      const pack = newContextPack(doc.title);
      const triage = artifacts.triage ?? {};
      const domain = triage['domain'];
      if (typeof domain === 'string') pack.fieldHint = domain;
      const queries = Array.isArray(triage['search_queries'])
        ? (triage['search_queries'] as unknown[]).filter(
            (q): q is string => typeof q === 'string',
          )
        : [];
      const router = new SearchRouter({
        order: settings.searchOrder,
        keys: searchApiKeys ?? {},
      });

      // -- collection (fail-soft: one warn, keep whatever arrived) ----------
      try {
        const oa = new OpenAlexClient();
        const items: LiteratureItem[] = [];
        // Python run() slices search_queries to 8 (LLM-controlled list —
        // unbounded would mean unbounded sequential round-trips).
        for (const q of queries.slice(0, 8)) {
          items.push(...(await oa.searchWorks(q, 5)));
          if (items.length >= 30) break;
        }
        // Web search for very recent / non-scholarly context.
        for (const q of queries.slice(0, 3)) {
          for (const hit of await router.search(q, 4)) {
            items.push(hitToItem(hit, 'Web result (recent or non-scholarly source)'));
          }
        }
        // Dedupe by normalized title (Python: re.sub(r'\W+','',lower)[:80]).
        const seen = new Set<string>();
        for (const it of items) {
          const key = normalizeTitleKey(it.title);
          if (key && !seen.has(key)) {
            seen.add(key);
            pack.items.push(it);
          }
        }
        // 7e DM relevance filter (batched predicates over the first 40
        // items): dormant without a decider, keeping all items.
        await dmSurveyFilter(artifacts.triage ?? {}, pack);
      } catch (err) {
        console.warn(
          `literature collection degraded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // -- surveyor refines relevance + missing refs (SMALL role) -----------
      // The whole survey stage fails (and marks the run partial) only on an
      // LLM error from the surveyor itself, mirroring Python `_stage_or_resume`
      // re-raising LLMError; network degradation below never fails the run.
      const surveyRes = await callJson('small', surveySystem, renderPack(pack, 30), {
        callType: 'surveyor',
      });
      const keep = yield* settle('survey', surveyRes, async (v) => {
        const survey = (v ?? {}) as Record<string, unknown>;
        // 1-based index mapping onto the deduped pack items.
        const selected = Array.isArray(survey['selected']) ? survey['selected'] : [];
        for (const sel of selected) {
          if (typeof sel !== 'object' || sel === null) continue;
          const so = sel as Record<string, unknown>;
          const idx = so['index'];
          if (
            typeof idx === 'number' &&
            Number.isInteger(idx) &&
            idx >= 1 &&
            idx <= pack.items.length
          ) {
            const why = so['why_relevant'];
            pack.items[idx - 1]!.whyRelevant = typeof why === 'string' ? why : null;
          }
        }
        // Missing refs -> Crossref lookup, appended with why_important.
        // Python awaits these inside the same client context block; lookups
        // are bounded (5) and fail-soft, so inline await is parity-safe.
        const missing = Array.isArray(survey['missing_references'])
          ? survey['missing_references']
          : [];
        try {
          const cr = new CrossrefClient();
          for (const m of missing.slice(0, 5)) {
            if (typeof m !== 'object' || m === null) continue;
            const mo = m as Record<string, unknown>;
            const title = mo['title'];
            if (typeof title !== 'string' || title === '') continue;
            const extra = await cr.lookup(title);
            if (extra) {
              const why = mo['why_important'];
              extra.whyRelevant = typeof why === 'string' ? why : null;
              pack.items.push(extra);
            }
          }
        } catch (err) {
          console.warn(
            `missing-reference enrichment degraded: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // state_of_the_art_notes appends to field_hint (Python [:400]).
        const notes = survey['state_of_the_art_notes'];
        if (typeof notes === 'string') {
          pack.fieldHint = ((pack.fieldHint ?? '') + ` — ${notes}`).slice(0, 400);
        }
        artifacts.survey = pack;
        await syncArtifacts();
      });
      if (!keep && surveyRes.kind === 'budget') budgetError = surveyRes.error;
    }

    // -------------------------------------------------------------- 2b. scout --
    // Python `_scout`: scan the paper title + the top MAX_CITATION_SCANS key
    // citations on the review-community sites; findings extend the pack.
    // Entirely fail-soft: a dead search engine or CORS-blocked site can never
    // fail the run.
    if (!budgetError && artifacts.survey && !skipIfDone('scout')) {
      yield* emit('scout', 'running');
      try {
        const pack = artifacts.survey;
        const triage = artifacts.triage ?? {};
        const keyCitations = Array.isArray(triage['key_citations'])
          ? (triage['key_citations'] as unknown[]).filter(
              (c): c is string => typeof c === 'string',
            )
          : [];
        const router = new SearchRouter({
          order: settings.searchOrder,
          keys: searchApiKeys ?? {},
        });
        const scout = new PeerReviewScout(undefined, router);
        const found = await scout.scanTitle(doc.title);
        for (const c of keyCitations.slice(0, MAX_CITATION_SCANS)) {
          // Python: strip an "Author, Year: " style prefix before scanning.
          const citTitle = c.replace(/^.*?:\s*/, '');
          found.push(...(await scout.scanCitation(citTitle)));
        }
        pack.items.push(...found.slice(0, 15));
        yield* emit('scout', 'done', `${found.length} community hits`);
      } catch (err) {
        console.warn(
          `scout degraded: ${err instanceof Error ? err.message : String(err)}`,
        );
        yield* emit(
          'scout',
          'failed',
          `scout degraded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (!budgetError) {
      yield* emit('scout', 'skipped', 'no context pack from survey stage');
    }

    // --------------------------------------------------- 3. verify --
    // Per-claim workers first (the primary engine), then per-section lenses
    // (depth preset), then the whole-paper coherence pass. Mirrors Python
    // `_verify` minus artifact vision (deferred to Stage 5+).
    if (!budgetError && !noContinuation && !skipIfDone('verify')) {
      yield* emit('verify', 'running');
      let unitsDone = 0;
      let stageBroken = false;

      // 3-pre. deterministic checkers: cross-references, number consistency,
      // table arithmetic — zero LLM cost, findings stored on the run state.
      // Python coupling: the gate is `if not self.state.checker_findings` —
      // the doi-resolution findings (bibliography) share the same array, so a
      // run that already has them skips this scan and vice versa.
      if ((state.checkerFindings ?? []).length === 0) {
        const det = runDeterministicChecks(doc);
        state.checkerFindings = det.map(findingToDict);
        // Persist BEFORE the verify stage completes (established pattern).
        await saveRun(state);
        if (det.length > 0) {
          const kinds = new Map<string, number>();
          for (const f of det) kinds.set(f.check, (kinds.get(f.check) ?? 0) + 1);
          yield* emit(
            'verify',
            'running',
            'deterministic checks: ' +
              [...kinds.entries()]
                .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
                .map(([k, v]) => `${k}×${v}`)
                .join(', '),
          );
        }
      }

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
          maxClaims: planKnobs.max_claims,
          claimsRanked,
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
      // Python `_verify`: a replan checkpoint after the claims sub-stage
      // (7e review B5 — same helper as the whole-stage checkpoints). On
      // wrap-up (noContinuation) the remaining sub-stages and the done emit
      // are skipped: Python's ReviewIncomplete ends the walk immediately.
      if (!budgetError && !noContinuation && isAuto && harness.plan !== undefined) {
        yield* replanCheckpoint('verify/claims');
      }
      if (noContinuation) {
        state.partial = true;
        await saveRun(state);
        yield* emit('verify', 'done', 'wrapped up early (no feasible continuation)');
        // Assemble the partial wrap-up report NOW (mirrors the budget drain's
        // assemble tail): mark never-started stages skipped, anchor the
        // checker + verified comments, clear the report for the resumable
        // top-up. Python's ReviewIncomplete carries the wrap-up report out
        // of run(); the TS driver surfaces it as the drained partial.
        for (const stage of WRAP_ORDER) {
          if (stageStatus(state, stage) === 'pending') {
            yield* emit(stage, 'skipped', 'no feasible continuation');
          } else if (stage === 'challenge' && stageStatus(state, stage) === 'running') {
            // The wrap-up emit above used 'challenge/running'; the stage
            // never completes — close it as skipped for the resume gate.
            yield* emit(stage, 'skipped', 'no feasible continuation');
          }
        }
        // The partial report is NOT persisted: the resumable top-up contract
        // (Stage 7c) requires the report cleared so `skipIfDone`/
        // `firstOpenStage` re-enter every not-completed stage after the user
        // raises the budget; the eventual assemble (post top-up) produces the
        // anchored shape. The skip trail + shortfall on the state carry the
        // wrap-up information for the UI.
        syncBudgetToState();
        await saveRun(state);
        yield* emit('assemble', 'done', 'partial wrap-up report assembled');
        return;
      }

      // 3b. per-section lenses (Python `_lenses_for` + `_reviewable_sections`);
      // gated by the plan's per_section_lenses knob (plan_knobs in auto).
      if (planKnobs.per_section_lenses) {
        const lenses = lensesFor(artifacts.triage ?? {});
        const sections = reviewableSections(doc);
        const lensTotal = sections.length * lenses.length;
        for (const lens of lenses) {
          for (const sec of sections) {
            // Python run_lens_section: budget_allows gate before the call.
            if (!harness.allow_call('lens_section')) {
              harness.note_gate_stop('lens_section', 1);
              unitsDone += 1;
              continue;
            }
            const res = await callJsonWithRepair(
              callJson,
              'small',
              lens.system,
              verifierPrompt(
                `${sec.title} — ${lens.name} lens`,
                '',
                sec.text.slice(0, MAX_SECTION_CHARS),
              ),
              'lens_section',
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
      // Python `_verify`: a replan checkpoint after the lens sub-stage
      // (7e review B5). When the checkpoint wraps up (no continuation), the
      // stage-level gates below see noContinuation and skip every remaining
      // LLM-consuming pass.
      if (!budgetError && !noContinuation && isAuto && harness.plan !== undefined) {
        yield* replanCheckpoint('verify/lenses');
      }

      // 3c. whole-paper coherence pass (strong model, full text)
      if (!budgetError && !noContinuation && planKnobs.whole_paper_passes) {
        const wpRes = await callJsonWithRepair(
          callJson,
          'strong',
          wholePaperVerifierSystem,
          wholePaperVerifierPrompt(doc.title, manuscript),
          'whole_paper_verify',
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

      // Python `_verify`: a replan checkpoint after the artifact-verification
      // sub-stage (7e review B5; the TS pipeline's artifact pass is folded
      // into the deterministic scan + whole-paper tail — the checkpoint
      // anchors at the same position, after all breadth passes).
      if (!budgetError && !noContinuation && isAuto && harness.plan !== undefined) {
        yield* replanCheckpoint('verify/artifacts');
      }

      if (budgetError) {
        // fall through to the assemble drain
      } else if (stageBroken) {
        state.partial = true;
        await saveRun(state);
        yield* emit('verify', 'failed', 'one or more verification workers failed');
      } else {
        // Persist the verify output (Python artifacts['candidates']) BEFORE
        // announcing done — a resume must find the candidates or the
        // challenge would silently re-run over nothing.
        await syncArtifacts();
        yield* emit('verify', 'done', undefined, {
          unitsDone,
          unitsTotal: Math.max(unitsDone, 1),
        });
      }
    }

    // Python run(): a replan checkpoint after the verify stage (auto mode).
    if (!budgetError && isAuto && harness.plan !== undefined) {
      yield* replanCheckpoint('verify');
    }

    // ------------------------------------------------------ 4. challenge --
    // Python `_challenge` semantics: per-section challenger passes over the
    // CANDIDATE list (claims + lens findings), then a whole-paper challenger
    // validates what no section challenger claimed and hunts global issues.
    if (!budgetError && !noContinuation && !skipIfDone('challenge')) {
      yield* emit('challenge', 'running');
      const sections = reviewableSections(doc);
      let unitsDone = 0;
      let stageBroken = false;
      let wpGateStopped = false;
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
        // 81f5a61: challengers respect the budget affordance gate — pass this
        // section's candidates through unvalidated rather than burning budget
        // the plan does not have (challengers are validators, not creators).
        if (!harness.allow_call('section_challenger')) {
          harness.note_gate_stop('section_challenger', 1);
          challengeValidated.push(...cands);
          unitsDone += 1;
          continue;
        }
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
          'section_challenger',
        );
        unitsDone += 1;
        const nowProgress: StageProgress = { unitsDone, unitsTotal: sections.length };
        if (res.kind === 'ok') {
          // fe463f2: models sometimes return the validated list bare instead
          // of the documented {"validated": [...], "new_comments": [...]}
          // envelope; 61f5822: skip non-dict payloads.
          let o =
            typeof res.value === 'object' && res.value !== null
              ? (res.value as Record<string, unknown>)
              : undefined;
          if (Array.isArray(res.value)) {
            o = { validated: res.value };
          } else if (o === undefined) {
            o = {};
          }
          // kept: challenger verdicts that were not dropped
          const kept: ReviewComment[] = [];
          if (Array.isArray(o['validated'])) {
            for (const v of o['validated']) {
              if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
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
          // new_comments: hunter findings from this section (61f5822:
          // non-dict payloads skipped)
          const fresh: ReviewComment[] = [];
          if (Array.isArray(o['new_comments'])) {
            for (const nc of o['new_comments']) {
              if (typeof nc !== 'object' || nc === null || Array.isArray(nc)) continue;
              fresh.push(
                challengerComment(nc as Record<string, unknown>, sec.title, res.value),
              );
            }
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
        // 81f5a61: the affordance gate applies here too — pass the
        // cross-section candidates through unvalidated (Python
        // `validated.extend(wp_candidates); return await defense_round(...)`;
        // the defense tail below still runs, matching Python).
        if (!harness.allow_call('whole_paper_challenge')) {
          harness.note_gate_stop('whole_paper_challenge', 1);
          challengeValidated.push(...wpCandidates);
          wpGateStopped = true;
        }
        const wpRes = wpGateStopped
          ? ({ kind: 'skipped_gate' } as const)
          : await callJsonWithRepair(
              callJson,
              'strong',
              wholePaperChallengerSystem,
              wholePaperChallengerPrompt(
                doc.title,
                manuscript,
                // Python: json.dumps(wp_candidates, indent=1)[:30_000]
                JSON.stringify(wpCandidates, null, 1).slice(0, 30_000),
              ),
              'whole_paper_challenge',
            );
        if (wpRes.kind === 'skipped_gate') {
          // candidates already passed through; the challenge tail (defense)
          // continues below — Python `return await defense_round(...)`.
          yield* emit('challenge', 'running', 'whole-paper challenge: budget gate');
        } else if (wpRes.kind === 'ok') {
          // fe463f2: bare validated list instead of the documented envelope;
          // 61f5822: non-dict payloads skipped (Python parity).
          let o =
            typeof wpRes.value === 'object' && wpRes.value !== null
              ? (wpRes.value as Record<string, unknown>)
              : undefined;
          if (Array.isArray(wpRes.value)) {
            o = { validated: wpRes.value };
          } else if (o === undefined) {
            o = {};
          }
          if (Array.isArray(o['validated'])) {
            for (const v of o['validated']) {
              if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
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
            for (const nc of o['new_comments']) {
              if (typeof nc !== 'object' || nc === null || Array.isArray(nc)) continue;
              challengeValidated.push(
                challengerComment(
                  nc as Record<string, unknown>,
                  'Full manuscript',
                  wpRes.value,
                ),
              );
            }
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
      // output (not the raw candidates) feeds meta and validate. Gated by
      // the plan's defense_round knob (7c).
      if (!budgetError && planKnobs.defense_round && challengeValidated.length > 0) {
        yield* emit('challenge', 'running', 'defense gate');
        const gate = await defenseRound({
          callJson,
          doc,
          candidates: challengeValidated,
          settings,
          // 7e: when a decision role is configured the gate switches to
          // batched DM adjudication (40 comments per decide() call, anchored
          // manuscript passages); without one the per-comment LLM gate runs
          // exactly as before (byte-identical call sequences).
          decide,
        });
        challengeValidated.length = 0;
        challengeValidated.push(...gate.kept);
        if (gate.budget) budgetError = gate.budget;
      }
      if (!budgetError) {
        artifacts.challenge = [...challengeValidated];
        await syncArtifacts();
      }
    }

    // Python run(): a replan checkpoint after the challenge stage (auto mode)
    // — gated exactly like the verify checkpoint (isAuto && plan): the replan
    // runs regardless of whether a decider is bound.
    if (!budgetError && isAuto && harness.plan !== undefined) {
      yield* replanCheckpoint('challenge');
    }

    // --------------------------------------------------- 4b. bibliography --
    // Python `_bibliography`: SMALL citation audit against the context pack;
    // fail-soft (empty audit on LLM error), budget surfaces. Python also
    // runs `_resolve_references` first: a deterministic Crossref/OpenAlex
    // pass whose records are memoized on RunState (`doi_resolutions`,
    // persisted BEFORE the audit), rendered into the new {resolution} prompt
    // slot, and whose unmatched entries (first 20) become deterministic
    // checker findings on RunState (NOT report comments — 7b wires those).
    if (!budgetError && !noContinuation && !skipIfDone('bibliography')) {
      yield* emit('bibliography', 'running');
      if (!state.doiResolutions) {
        // Fail-soft (Python catches everything): resolution errors -> no
        // records -> '(resolution unavailable)'.
        let records: ResolutionRecord[] = [];
        try {
          const clients: ResolutionClients = {
            crossref: new CrossrefClient(),
            openalex: new OpenAlexClient(),
          };
          records = await resolveReferences(doc.referencesText ?? '', clients);
        } catch (err) {
          console.warn(
            `reference resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          records = [];
        }
        state.doiResolutions = records;
        // Persist BEFORE the bibliography audit (Python saves state first).
        await saveRun(state);
        // Unmatched records become deterministic checker findings (Python
        // `_resolve_references` finding loop, exact wording).
        const unmatched = records.filter((r) => r.status !== 'matched');
        if (unmatched.length > 0) {
          const findings = state.checkerFindings ?? [];
          for (const r of unmatched.slice(0, 20)) {
            findings.push({
              check: 'doi-resolution',
              title: 'Reference not resolvable in Crossref/OpenAlex',
              message:
                'The bibliography entry below could not be matched to ' +
                'any Crossref or OpenAlex record (best score ' +
                `${r.score ?? 0}). It may be phantom, garbled, or ` +
                'use an unusual rendering — verify it exists.',
              quote: String(r.ref ?? '').slice(0, 240),
              category: 'reference',
              severity: 0.4,
              meta: { kind: 'unmatched', score: r.score ?? 0 },
              provenance: 'deterministic',
            });
          }
          state.checkerFindings = findings;
        }
      }
      const bibJson: CallJson = (role, system, user) => callJson(role, system, user);
      const bibRun = await runBibliographyAudit({
        callJson: bibJson,
        doc,
        pack: artifacts.survey ?? newContextPack(doc.title),
        resolution: renderResolutions(
          (state.doiResolutions ?? []) as ResolutionRecord[],
        ),
        settings,
      });
      if (bibRun.budget) budgetError = bibRun.budget;
      artifacts.bibliography = bibRun.audit;
      await syncArtifacts();
      if (bibRun.budget) {
        yield* emit(
          'bibliography',
          'failed',
          `budget cap reached: ${bibRun.budget.message}`,
        );
      } else if (
        bibRun.audit.entries.length === 0 &&
        bibRun.audit.in_text_issues.length === 0 &&
        !doc.referencesText
      ) {
        yield* emit('bibliography', 'skipped', 'no references section detected');
      } else if (
        bibRun.audit.entries.length === 0 &&
        bibRun.audit.in_text_issues.length === 0
      ) {
        // LLM failure: Python logs a warning and carries the empty audit on.
        state.partial = true;
        await saveRun(state);
        yield* emit('bibliography', 'failed', 'citation audit failed (empty result)');
      } else {
        yield* emit(
          'bibliography',
          'done',
          `${bibRun.audit.entries.length} entries audited`,
        );
      }
    }

    // e2ba304 alignment: ONE checker-comments instance, consumed at assemble
    // ONLY (the findings never enter the LLM stream — meta's dedup dissolved
    // 28 deterministic findings into one prose comment in a real-world RMI
    // run). Computed AFTER bibliography — the doi-resolution findings land in
    // state.checkerFindings there — so the stream is complete.
    // checker bound above (used at assemble; also at a mid-verify wrap-up)

    // --------------------------------------------------- 5. meta --
    if (!budgetError && !noContinuation && !skipIfDone('meta')) {
      yield* emit('meta', 'running');
      // e2ba304 (7f F1): deterministic checker findings do NOT enter the
      // merge — they are code-verified and already distinct; meta's dedup
      // dissolved them (RMI: 20 doi + 8 xref findings merged into one prose
      // comment). They are prepended at assemble, provenance intact.
      const merged = [...challengeValidated];
      // Python: json.dumps(merged, indent=1)[: max(100_000, 900 * n_comments)]
      // (9a40f13: the preservation contract keeps every distinct finding, so
      // both the input listing and the re-emitted output scale with comment
      // count — static caps truncated large merges mid-JSON).
      const commentsJson = JSON.stringify(merged, null, 1).slice(
        0,
        metaCommentsJsonCap(merged.length),
      );
      // Python `_meta` L619-624: bib_summary rides into the meta prompt.
      const bib = artifacts.bibliography ?? emptyAudit();
      const bibSummary = JSON.stringify({
        entries: bib.entries,
        in_text_issues: bib.in_text_issues,
      }).slice(0, 8000);
      // Python `_meta`: the meta output budget scales with the merged
      // comment count — max(call_max_tokens('meta', level), min(32768,
      // 2000 + 130*n)) (closes the 7a "not scaled" divergence).
      const metaMax = Math.max(
        callMaxTokens('meta', planKnobs.output_budget) ?? 8192,
        Math.min(32_768, 2_000 + 130 * merged.length),
      );
      const metaRes = await callJson(
        'strong',
        metaSystem,
        metaPrompt(
          doc.title,
          JSON.stringify(artifacts.triage ?? {}),
          commentsJson,
          bibSummary,
          // Python _meta: sota_notes=(pack.field_hint or '')[:1500]
          (artifacts.survey?.fieldHint ?? '').slice(0, 1500),
        ),
        { callType: 'meta', maxTokens: metaMax },
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
        // Python draft['comments']: the merger's deduplicated list, the
        // synthesis listing's source (dicts only, 61f5822 parity).
        artifacts.metaComments = (
          typeof v === 'object' &&
          v !== null &&
          Array.isArray((v as Record<string, unknown>)['comments'])
            ? ((v as Record<string, unknown>)['comments'] as unknown[])
            : []
        ).filter(
          (c): c is Record<string, unknown> =>
            typeof c === 'object' && c !== null && !Array.isArray(c),
        );
        // 7f synthesis: the lead-referee essay over the merger's
        // deduplicated comments replaces the merger's own overall feedback
        // (NOT additive). Gated on the knob + the affordance gate; a failed
        // pass keeps the merger's overall (Python logs + returns None). A
        // synthesis BUDGET trip propagates like every other stage (7f review
        // D3: Python BudgetExceeded drains — partial report, validate
        // skipped), so it must not be swallowed here.
        if (planKnobs.synthesis && harness.allow_call('synthesis')) {
          const essay = await runSynthesis(bib);
          if (essay instanceof BudgetExceeded) {
            // The synthesis budget trip drains the run (Python: the error
            // propagates out of _meta into run()'s BudgetExceeded handler,
            // so the meta stage never completes) — record the drain and
            // fall through to the assemble path without the done emit.
            budgetError = essay;
            state.partial = true;
            await saveRun(state);
            yield* emit('meta', 'failed', `budget cap reached: ${essay.message}`);
          } else {
            if (essay !== undefined) artifacts.overall = essay;
            // Persist the draft review (Python artifacts['draft_review'])
            // BEFORE announcing done — a resume after meta must not lose
            // the verdict.
            await syncArtifacts();
            yield* emit('meta', 'done');
          }
        } else {
          // Persist the draft review (Python artifacts['draft_review']) BEFORE
          // announcing done — a resume after meta must not lose the verdict.
          await syncArtifacts();
          yield* emit('meta', 'done');
        }
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
    // e2ba304: the validator sees the challenge-validated LLM stream ONLY —
    // deterministic checker findings skip validate entirely (their comment:
    // "meta's dedup dissolved them"); they render fresh at assemble.
    if (
      !budgetError &&
      !noContinuation &&
      !skipIfDone('validate') &&
      challengeValidated.length > 0
    ) {
      yield* emit('validate', 'running');
      // 7e Python `_dm_validator_gate`: batched grounding predicates (60 per
      // decide call) drop ungrounded comments BEFORE the validator pass;
      // dormant without a decider (identity on the list).
      const gated = await dmValidatorGate(
        doc,
        challengeValidated as unknown as Record<string, unknown>[],
        manuscript,
      );
      const gatedComments = gated as unknown as ReviewComment[];
      // Python: json.dumps(validated, indent=1)[:60_000]
      const commentsJson = JSON.stringify(gatedComments, null, 1).slice(0, 60_000);
      const valRes = await callJson(
        'strong',
        validatorSystem,
        validatorPrompt(doc.title, manuscript, commentsJson, artifacts.overall),
        { callType: 'validate' },
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
        gatedComments.forEach((c, i) => {
          if (!rejected.has(i)) validated.push(c);
        });
        yield* emit('validate', 'done');
      } else if (valRes.kind === 'budget') {
        budgetError = valRes.error;
      } else {
        // Keep all candidates when validation itself fails.
        validated.push(...gatedComments);
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
    } else if (!budgetError && challengeValidated.length === 0) {
      yield* emit('validate', 'skipped', 'no candidates to validate');
    }

    // ---------------------------------------------------------- 6b. copyedit --
    // Python 9b `_copyedit`: one SMALL language-mechanics pass; fail-soft ->
    // [] on any LLM/parse failure, budget propagates. The artifact persists
    // BEFORE the done-emit so resume skips the re-call. 7c: the two Python
    // gates are wired — `plan_knobs().copyedit` (knob off -> emit skipped,
    // like Python's early return, which never marks the stage) and
    // `budget_allows('copyedit')` (gate stop recorded, stage skipped).
    if (!budgetError && !noContinuation && !skipIfDone('copyedit')) {
      if (!planKnobs.copyedit) {
        // Python: `if not plan_knobs().copyedit: return []` — no stage
        // transition at all; the run's stage list just moves on.
        yield* emit('copyedit', 'skipped', 'plan knobs exclude the copyedit annex');
      } else if (!harness.allow_call('copyedit')) {
        // Python: `if not budget_allows('copyedit'): note_gate_stop; return []`
        harness.note_gate_stop('copyedit', 1);
        yield* emit('copyedit', 'skipped', 'budget gate: copyedit skipped');
      } else {
        yield* emit('copyedit', 'running');
        const copyJson: CallJson = (role, system, user, opts) =>
          callJson(role, system, user, opts);
        const copyRun = await runCopyEditStage({
          callJson: copyJson,
          doc,
          manuscript,
        });
        if (copyRun.budget) budgetError = copyRun.budget;
        // Persist the artifact (Python artifacts['copyedit_items']) BEFORE the
        // terminal event — resume must find it or the annex re-calls.
        artifacts.copyeditItems = copyRun.items;
        await syncArtifacts();
        if (copyRun.budget) {
          yield* emit(
            'copyedit',
            'failed',
            `budget cap reached: ${copyRun.budget.message}`,
          );
        } else if (copyRun.items.length === 0) {
          // LLM failure or genuinely nothing to fix: never blocks the report.
          yield* emit('copyedit', 'done', 'no copyedit items');
        } else {
          yield* emit('copyedit', 'done', `${copyRun.items.length} language fixes`);
        }
      }
    }

    // ---------------------------------------------------------- 7. assemble --
    // Never-started stages, for the explicit partial trail (drain + wrap-up).
    const order: Stage[] = [
      'triage',
      'claims',
      'survey',
      'scout',
      'verify',
      'challenge',
      'bibliography',
      'meta',
      'validate',
      'copyedit',
    ];
    if (budgetError) {
      // Mark the never-started stages skipped so the state machine is explicit.
      for (const stage of order) {
        if (stageStatus(state, stage) === 'pending') {
          yield* emit(stage, 'skipped', 'budget cap reached earlier in the run');
        }
      }
      state.partial = true;
      await saveRun(state);
      yield* emit('assemble', 'skipped', `budget cap reached: ${budgetError.message}`);
    } else {
      if (noContinuation) {
        // 7e review (B4): the wrap-up drain marks every never-started stage
        // skipped, mirroring the budget drain — the partial trail is
        // explicit for the UI and the resume gate.
        for (const stage of order) {
          if (stageStatus(state, stage) === 'pending') {
            yield* emit(stage, 'skipped', 'no feasible continuation');
          }
        }
      }
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

    // Python `_assemble` (e2ba304): deterministic checker findings are
    // prepended FRESH at assemble — `list(self._checker_comments()) + ...`.
    // They never rode the LLM stream (meta/validate see only validated LLM
    // comments now), so no dedupe is needed and provenance is intact.
    const finalComments: unknown[] = [...checker(), ...validated];
    // provenance lost to meta/validator re-emission: re-attach from the
    // verify-stage candidates (checker findings carry provenance already;
    // upstream pins all det comments keep quote+provenance) (9a40f13).
    reattachProvenance(finalComments, [
      ...((state.artifacts?.candidates ?? []) as unknown[]),
    ]);
    const anchored: ReviewComment[] = (finalComments as ReviewComment[]).map((c, i) => {
      const anchor = c.paragraphAnchor ?? '';
      const quote = c.quote ?? '';
      const { blockId, confidence } = resolveAnchor(doc, anchor, quote);
      return {
        ...c,
        id: `c${String(i).padStart(3, '0')}`,
        blockId: blockId ?? undefined,
        anchorConfidence: confidence,
        section: c.section || sectionOfBlock(doc, blockId) || '',
        // Python assemble fallback: title=c.get('title') or 'Untitled comment'
        title: c.title || 'Untitled comment',
      };
    });

    const report: ReviewReport = {
      paperTitle: doc.title,
      recommendation,
      overall: artifacts.overall || '_(no meta-review produced)_',
      comments: anchored,
      copyeditItems: artifacts.copyeditItems,
      usage,
      partial: state.partial || budgetError !== undefined,
      generatedAt: new Date().toISOString(),
    };
    state.report = report;
    // Python `wrapup_incomplete` marks the run INCOMPLETE (status), letting
    // the resume endpoint accept it after a top-up. The TS resume gate is
    // `report !== undefined` for skipped stages — a budget-drained run
    // PERSISTS its report for the UI but must NOT pin the skipped stages:
    // clear the report on drain so `skipIfDone`/`firstOpenStage` re-enter
    // every not-completed stage on resume (resumable top-up, Stage 7c).
    // 7e review (B4): the wrap-up path (noContinuation) mirrors the drain —
    // Python's wrapup_incomplete marks the run INCOMPLETE so a top-up can
    // resume it; the TS resume gate is the same report-clearing contract
    // (Stage 7c): the partial report rides the yield for the UI, the
    // persisted state stays resume-ready.
    if (budgetError || noContinuation) {
      state.report = undefined;
    }
    syncBudgetToState();
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
        'scout',
        'verify',
        'challenge',
        'bibliography',
        'meta',
        'validate',
        'copyedit',
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
