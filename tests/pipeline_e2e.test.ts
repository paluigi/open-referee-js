import { beforeEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline/orchestrator';
import type { StageProgress } from '../src/pipeline/orchestrator';
import type { RunState, StageEvent } from '../src/pipeline/state';
import { listRuns, loadRun } from '../src/runs/store';
import type { Document } from '../src/ingestion/document';
import { readMarkdown } from '../src/ingestion/readers_md';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
import { surveySystem } from '../src/pipeline/prompts';
import { LLMError } from '../src/providers/base';
import type {
  ChatMessage,
  ChatProvider,
  LLMResponse,
  ModelSpec,
} from '../src/providers/base';
import {
  IDBFactory,
  IDBRequest,
  IDBDatabase,
  IDBObjectStore,
  IDBKeyRange,
  IDBCursor,
  IDBCursorWithValue,
  IDBIndex,
  IDBTransaction,
  IDBOpenDBRequest,
  IDBVersionChangeEvent,
} from 'fake-indexeddb';

const MD = `# Test Paper

## Introduction

We prove the main theorem in this paper and claim novelty over all prior work.
Our method introduces an entirely new bounding technique for the objective
function, which no earlier paper in this literature has attempted to use. The
key insight is that the constraint set admits a decomposition into convex
components, each of which can be handled with classical duality arguments
without any regularity conditions beyond measurability of the underlying
mapping and finiteness of the second moment of the perturbation term.

## Methods

The estimator uses a two-stage procedure with clustering at the unit level.
Standard errors are computed by bootstrap with 999 replications, and all
regressions include stratification by the treatment assignment variable. In
the first stage we estimate the nuisance function on a held-out split and
then plug it into the moment condition; in the second stage we re-center the
score and apply the influence-function correction. The asymptotic variance
estimator follows the standard sandwich form with an additional term that
accounts for the estimated nuisance parameter.
`;

function makeDoc(): Document {
  return readMarkdown(MD);
}

function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    // Default test pricing: $2/1M input, $8/1M output.
    pricing: { 'm-strong': { input: 2, output: 8 } },
    roles: {
      strong: { provider: 'strong', model: 'm-strong' },
      small: { provider: 'small', model: 'm-small' },
      vision: { provider: '', model: '' },
    },
    // Lenses + defense make the call matrix explode; default tests to
    // claim-workers only (the primary engine). Lenses/defense have their
    // own dedicated tests below.
    review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    ...partial,
  };
}

/** Scriptable provider that also records specs. */
class ScriptedProvider implements ChatProvider {
  readonly calls: { messages: ChatMessage[]; spec: ModelSpec }[] = [];
  private script: (string | Error)[] = [];

  queue(...contents: (string | Error)[]): void {
    this.script.push(...contents);
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    const item = this.script.shift();
    if (item === undefined) throw new Error('scripted provider queue empty');
    if (item instanceof Error) throw item;
    this.calls.push({ messages, spec });
    return {
      content: item,
      usage: { promptTokens: 100, completionTokens: 50 },
      model: spec.model,
    };
  }

  close(): void {}
}

function j(obj: unknown): string {
  return JSON.stringify(obj);
}

async function drain(gen: AsyncGenerator<StageEvent, RunState, undefined>) {
  const events: StageEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { state: next.value, events };
    events.push(next.value);
  }
}

beforeEach(() => {
  // IndexedDB store writes happen inside the orchestrator (saveRun/appendEvent).
  const g = globalThis as unknown as Record<string, unknown>;
  // No network in pipeline e2e: the survey stage now issues real fetches the
  // moment a triage fixture carries search_queries — pin that down.
  g.fetch = () => Promise.reject(new TypeError('no network in pipeline e2e'));
  g.indexedDB = new IDBFactory();
  g.IDBRequest = IDBRequest;
  g.IDBDatabase = IDBDatabase;
  g.IDBObjectStore = IDBObjectStore;
  g.IDBKeyRange = IDBKeyRange;
  g.IDBCursor = IDBCursor;
  g.IDBCursorWithValue = IDBCursorWithValue;
  g.IDBIndex = IDBIndex;
  g.IDBTransaction = IDBTransaction;
  g.IDBOpenDBRequest = IDBOpenDBRequest;
  g.IDBVersionChangeEvent = IDBVersionChangeEvent;
});

describe('runReview happy path', () => {
  it('runs stages in order, emits shaped events, assembles the report', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({
        mathematical_density: 'light',
        statistical_content: 'regression',
        summary: 'A test paper.',
      }),
      // claims inventory: two atomic claims
      j({
        claims: [
          {
            id: 'cl001',
            type: 'theorem_proof',
            importance: 'central',
            components: { statement: 'the main theorem holds' },
            anchor: 'We prove the main theorem in this paper',
            section: 'Introduction',
          },
          {
            id: 'cl002',
            type: 'numerical',
            importance: 'supporting',
            components: { number: '999 replications' },
            anchor: 'bootstrap with 999 replications',
            section: 'Methods',
          },
        ],
      }),
      // verify: cl001 (theorem_proof, central) goes to the strong role;
      // cl002 (numerical) goes to small (queued separately)
      j({ comments: [] }),
      // challenge: 2 section challengers + whole-paper challenger
      j({ validated: [], new_comments: [] }),
      j({
        validated: [
          {
            paragraph_anchor: 'bootstrap with 999 replications',
            quote: '999 replications',
            message: 'The replication count contradicts Table 1.',
            score: 0.55,
            verdict: 'kept',
          },
        ],
        new_comments: [],
      }),
      j({ validated: [], new_comments: [] }),
      j({
        overall_feedback:
          '## Weaknesses\n\nThe novelty claim is overstated. Recommend major revision.',
        paper_summary: 's',
      }),
      // synthesis (7f): essay replaces the merger's overall feedback
      j({ overall_feedback: '## Synth essay. Recommend major revision.' }),

      // validator: keep index 0
      j({ validated: [0], rejected: [], reasons: 'ok' }),
    );
    const small = new ScriptedProvider();
    small.queue(
      // surveyor (SMALL role): selects nothing, no missing refs
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        comments: [
          {
            paragraph_anchor: 'bootstrap with 999 replications',
            quote: '999 replications',
            message: 'The replication count contradicts Table 1.',
            score: 0.55,
            category: 'statistical',
          },
        ],
      }), // numerical claim -> small role
      // copyedit annex (SMALL, after validate): one verbatim fix
      j({
        items: [
          {
            quote: 'bootstrap with 999 replications',
            suggestion: 'bootstrap with 1,000 replications',
            kind: 'Grammar',
          },
        ],
      }),
    );
    const settings = makeSettings();

    const progressCalls: (StageProgress | undefined)[] = [];
    const gen = runReview({
      doc: makeDoc(),
      settings,
      providers: { strong, small },
      onEvent: (_e, p) => progressCalls.push(p),
    });
    const { state, events } = await drain(gen);
    // Stage order (deduped: verify/challenge emit intermediate 'running' events too)
    const started = [
      ...new Set(events.filter((e) => e.status === 'running').map((e) => e.stage)),
    ];
    expect(started).toEqual([
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
    ]);

    // Event log shape
    for (const e of events) {
      expect(typeof e.at).toBe('string');
      expect(['pending', 'running', 'done', 'failed', 'skipped']).toContain(e.status);
    }
    expect(events[0]!.stage).toBe('triage');
    expect(events.some((e) => e.stage === 'claims' && e.status === 'done')).toBe(true);

    // Report assembled
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.paperTitle).toBe('Test Paper');
    expect(report.partial).toBe(false);
    expect(report.overall).toContain('major revision');
    expect(report.recommendation).toBe('major revision');
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]!.comment).toContain('replication count');
    expect(report.comments[0]!.claimId).toBe('cl002');
    expect(report.comments[0]!.paragraphAnchor).toBe('bootstrap with 999 replications');
    expect(report.usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(state.partial).toBe(false);

    // strong provider: triage, inventory, theorem_proof worker,
    // 2 section challengers, whole-paper challenger, meta, synthesis,
    // validator = 9
    // (wholePaperPasses=false: no whole-paper VERIFIER; the whole-paper
    // CHALLENGER is part of the challenge stage and always runs. The survey
    // moved to the SMALL role in Stage 5 — Python `_literature` parity.)
    expect(strong.calls).toHaveLength(9);
    // 7f: the synthesis call rides the meta stage (callType 'synthesis',
    // output-budgeted) and its essay REPLACES the merger's overall feedback
    expect(strong.calls[7]!.spec.maxTokens).toBe(6144);
    expect(strong.calls[7]!.messages[0]!.content).toContain('LEAD REFEREE');
    expect(report.overall).toBe('## Synth essay. Recommend major revision.');
    expect(strong.calls[0]!.spec.model).toBe('m-strong');
    expect(strong.calls[0]!.spec.temperature).toBe(0.2);
    expect(strong.calls[0]!.spec.maxTokens).toBe(4096);
    // small role: surveyor + the numerical claim worker + copyedit annex
    expect(small.calls).toHaveLength(3);
    expect(small.calls[0]!.messages[0]!.content).toBe(surveySystem);
    expect(small.calls[1]!.messages[1]!.content).toContain('[cl002]');

    // copyedit items flow into the report annex
    expect(report.copyeditItems).toEqual([
      {
        quote: 'bootstrap with 999 replications',
        suggestion: 'bootstrap with 1,000 replications',
        kind: 'grammar',
        section: 'Methods',
      },
    ]);

    // verify progress carries unitsDone/unitsTotal per claim
    const progress = progressCalls.filter((p) => p !== undefined);
    expect(progress.some((p) => p!.unitsTotal === 2)).toBe(true);

    // deterministic checkers ran at the verify head (zero LLM cost) — the
    // fixture has "999 replications" and Section headings, no dangling refs;
    // the claims inventory ANCHOR "bootstrap with 999 replications" is prose.
    // The MD fixture has no figure/table/theorem structure -> likely no xref
    // findings, but the checkerFindings state contract must hold either way.
    expect(Array.isArray(state.checkerFindings)).toBe(true);
    const det = state.checkerFindings as Record<string, unknown>[];
    for (const f of det) {
      expect(f['provenance']).toBe('deterministic');
      expect(typeof f['check']).toBe('string');
    }

    // state machine consistency
    expect(state.stages['assemble']).toBe('done');
    expect(state.stages['claims']).toBe('done');
    expect(state.stages['verify']).toBe('done');
    expect(state.events.length).toBe(events.length);
  });
});

describe('runReview budget exhaustion', () => {
  it('produces a partial report when the cap trips mid-run', async () => {
    const strong = new ScriptedProvider();
    // triage passes, then the claims-inventory projection trips the cap
    strong.queue(j({ mathematical_density: 'light', summary: 'x' }));
    const small = new ScriptedProvider();
    // Per-call check: measured projections — triage ~$0.01013, claims
    // inventory ~$0.01023; actuals ~$0.0006/call. Cap $0.0105: triage check
    // (~$0.01013) passes, then the claims-inventory check (~$0.0108 total)
    // trips before its call. Survey never starts.
    const settings = makeSettings({ maxCostUsd: 0.0105 });

    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings,
        providers: { strong, small },
      }),
    );

    expect(state.partial).toBe(true);
    // 7c: a budget-drained run persists its report for the UI but clears
    // state.report before the final save — skipped stages must stay
    // re-enterable for the resumable top-up. The partial report still
    // reached the caller through the drained generator (assert on stages).
    expect(state.stages['claims']).toBe('failed');
    expect(state.stages['survey']).toBe('skipped');
    expect(state.stages['verify']).toBe('skipped');
    expect(state.stages['meta']).toBe('skipped');
    expect(state.stages['validate']).toBe('skipped');
    // triage ran; the claims budget check tripped before any inventory call
    expect(strong.calls).toHaveLength(1);
    // assemble still closes the run out (partial report), so it ends done
    expect(state.stages['assemble']).toBe('done');
  });
});

describe('runReview validator filtering', () => {
  it('drops rejected comments', async () => {
    const strong = new ScriptedProvider();
    const comment = {
      paragraph_anchor: 'We prove the main theorem in this paper',
      quote: 'main theorem',
      message: 'good criticism',
      score: 0.8,
    };
    strong.queue(
      j({ summary: 's' }),
      // inventory: one claim so the challenger/whole-paper flow has candidates
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor: 'We prove the main theorem in this paper',
            section: 'Introduction',
          },
        ],
      }),
      j({}),
      // claim worker (logical -> strong)
      j({ comments: [comment] }),
      // section challenger (Intro keeps it) + section 2 + whole-paper
      j({ validated: [{ ...comment, verdict: 'kept' }], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'report', recommendation: 'minor revision' }),
      j({ validated: [0], rejected: [] }),
    );
    const small = new ScriptedProvider();
    // surveyor (SMALL role since Stage 5)
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      // copyedit annex
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.comments.map((c) => c.comment)).toEqual(['good criticism']);
  });

  it('defense gate: dismissed drops, adjusted merges, upheld keeps', async () => {
    const strong = new ScriptedProvider();
    const anchor = 'We prove the main theorem in this paper';
    const mk = (message: string, score: number) => ({
      paragraph_anchor: anchor,
      quote: 'main theorem',
      message,
      score,
    });
    strong.queue(
      j({ summary: 's' }),
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor,
            section: 'Introduction',
          },
        ],
      }),
      j({}),
      // claim worker emits THREE candidate comments
      j({
        comments: [mk('dismiss me', 0.7), mk('adjust me', 0.8), mk('keep me', 0.6)],
      }),
      // Intro challenger passes all three through
      j({
        validated: [
          mk('dismiss me', 0.7),
          mk('adjust me', 0.8),
          mk('keep me', 0.6),
        ].map((c) => ({ ...c, verdict: 'kept' })),
        new_comments: [],
      }),
      // Methods challenger (no candidates anchored there) + whole-paper
      j({ validated: [], new_comments: [] }),
      // defense gate runs at the challenge tail (Python parity), before
      // meta/validate: strong adjudicates the three candidates
      j({ verdict: 'dismissed', reason: 'correct' }),
      j({
        verdict: 'adjusted',
        reason: 'softer',
        comment: { message: 'adjusted message', score: 0.4 },
      }),
      j({ verdict: 'upheld' }),
      j({ overall_feedback: 'report', recommendation: 'minor revision' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      // validator sees the POST-gate list (2 comments) and keeps both
      j({ validated: [0, 1], rejected: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      // surveyor (SMALL role since Stage 5) runs before the defense gate
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      // small defends each comment before the strong adjudicator rules
      j({ defense: 'it is fine', defense_strength: 'strong' }),
      j({ defense: 'overstated', defense_strength: 'weak' }),
      j({ defense: 'no case', defense_strength: 'none' }),
      // copyedit annex
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings({
          review: {
            perSectionLenses: false,
            wholePaperPasses: false,
            defenseRound: true,
          },
        }),
        providers: { strong, small },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.comments.map((c) => c.comment)).toEqual([
      'adjusted message',
      'keep me',
    ]);
    expect(report.comments[0]!.severity).toBe(0.4);
    // defense on small (3 calls) + the surveyor + copyedit = 5; adjudication
    // on strong. The surveyor runs first (survey stage), then the defense
    // gate at the challenge tail, copyedit after validate.
    expect(small.calls).toHaveLength(5);
    expect(small.calls[0]!.messages[0]!.content).toBe(surveySystem);
    expect(small.calls[1]!.messages[0]!.content).toContain("AUTHORS' DEFENSE COUNSEL");
  });
});

describe('runReview malformed JSON', () => {
  it('fails the stage, sets partial, and still completes the run', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      'this is not json at all', // triage: garbage...
      'no json here either', // ...repair replay: garbage -> triage failed (7d: repair lives in callJson)
      'no json {{{ here', // inventory: garbage
      'again {{{ nope', // inventory repair replay: garbage -> claims failed
      // survey now runs on the SMALL role: garbage there too
      // challengers + whole-paper challenger run claimless
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      'also {{{ not json', // meta: garbage...
      'still {{{ not json', // ...repair replay: garbage -> meta failed
      j({ validated: [], rejected: [] }), // validator — never reached (no candidates)
    );
    const small = new ScriptedProvider();
    small.queue(
      'survey {{{ nope', // surveyor (SMALL): garbage...
      'still {{{ garbage', // ...repair replay: garbage -> survey failed
      j({ items: [] }), // copyedit annex (runs regardless; never blocks)
    );
    const settings = makeSettings();
    const { state, events } = await drain(
      runReview({
        doc: makeDoc(),
        settings,
        providers: { strong, small },
      }),
    );

    expect(state.stages['triage']).toBe('failed');
    expect(state.stages['claims']).toBe('failed');
    expect(state.stages['survey']).toBe('failed');
    expect(state.stages['meta']).toBe('failed');
    expect(state.stages['assemble']).toBe('done');
    expect(state.partial).toBe(true);
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments).toHaveLength(0);
    expect(events.some((e) => e.stage === 'triage' && e.status === 'failed')).toBe(
      true,
    );
    // validator never ran: no candidates to validate
    expect(state.stages['validate']).toBe('skipped');
  });

  it('continues after an LLMError mid-verify and keeps other workers', async () => {
    const anchor = 'We prove the main theorem in this paper';
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor,
            section: 'Introduction',
          },
        ],
      }),
      j({}),
      new LLMError('boom'), // claim worker fails
      // challengers: the failed worker's section candidates pass through
      // (empty), then the remaining sections + whole-paper run
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      // validator never runs: no candidates survived
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({ items: [] }), // copyedit annex
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments).toHaveLength(0);
    expect(state.stages['challenge']).toBe('failed');
    expect(state.stages['assemble']).toBe('done');
  });
});

describe('runReview crash recovery', () => {
  it('an unexpected error fails the running stage, persists, and rethrows', async () => {
    const strong = new ScriptedProvider();
    // Provider throws a plain TypeError (not LLMError) on the first call.
    strong.queue(new TypeError('socket hang up'));
    const events: StageEvent[] = [];
    const gen = runReview({
      doc: makeDoc(),
      settings: makeSettings(),
      providers: { strong, small: new ScriptedProvider() },
      onEvent: (e) => events.push(e),
    });
    // The generator must reject (error propagates to the consumer)…
    await expect(drain(gen)).rejects.toThrow(TypeError);
    // …but the run must be persisted in a terminal state, never 'running'.
    // (dbPromise is module-cached, so earlier tests in this file share the
    // same IDB instance — target the crashed run directly.)
    const runs = await listRuns();
    const saved = runs.find((r) => r.stages['triage'] === 'failed');
    expect(saved).toBeDefined();
    expect(saved!.partial).toBe(true);
    for (const stage of [
      'claims',
      'survey',
      'verify',
      'challenge',
      'meta',
      'validate',
      'assemble',
    ] as const) {
      // Missing stages are implicitly pending (Partial record).
      expect(saved!.stages[stage] ?? 'pending').toBe('pending');
    }
    // The failure event reached the UI stream too.
    const last = events.at(-1);
    expect(last?.stage).toBe('triage');
    expect(last?.status).toBe('failed');
    expect(last?.detail).toContain('socket hang up');
  });
});

describe('runReview depth preset wiring', () => {
  it('perSectionLenses=false runs claims+challengers only; true runs the lens matrix on small', async () => {
    // lenses off: triage + inventory (empty -> claims failed, no repair consumed)
    // + survey + 2 challengers + whole-paper challenger + meta + synthesis =
    // 7 strong calls (validator skipped: no candidates survive a claimless run)
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({ claims: [] }), // inventory empty -> claims stage failed, pipeline continues
      j({}),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
    );
    const small0 = new ScriptedProvider();
    small0.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({ items: [] }), // copyedit annex
    );
    await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small: small0 },
      }),
    );
    // triage + inventory + 2 section challengers + whole-paper challenger +
    // meta + synthesis = 7 (survey moved to small; validator skipped,
    // no candidates)
    expect(strong.calls).toHaveLength(7);

    // lenses on, whole-paper off: statistical_content 'regression' ->
    // prose + empirical + stats + lit + clarity = 5 lenses x 2 sections =
    // 10 SMALL calls (7f added the stats lens for empirical triage and made
    // clarity always-on; the surveyor makes it 11 on small overall)
    const strong2 = new ScriptedProvider();
    strong2.queue(
      j({ summary: 's', statistical_content: 'regression' }),
      j({ claims: [] }),
      j({}),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }), // whole-paper challenger (always runs)
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
    );
    const small2 = new ScriptedProvider();
    small2.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
    );
    for (let i = 0; i < 10; i++) small2.queue(j({ comments: [] }));
    small2.queue(j({ items: [] })); // copyedit annex
    await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings({
          review: { perSectionLenses: true, wholePaperPasses: false },
        }),
        providers: { strong: strong2, small: small2 },
      }),
    );
    expect(small2.calls).toHaveLength(12);
    // lens order: lens-outer loop -> 2 sections per lens: prose, prose,
    // empirical, empirical, stats, stats, lit, lit, clarity, clarity;
    // calls[0] is the surveyor (survey stage precedes verify).
    expect(small2.calls[1]!.messages[0]!.content).toContain(
      'INTERNAL COHERENCE REFEREE',
    );
    expect(small2.calls[3]!.messages[0]!.content).toContain(
      'STATISTICS AND ECONOMETRICS REFEREE',
    );
    expect(small2.calls[5]!.messages[0]!.content).toContain(
      'STATISTICAL RIGOR REFEREE',
    );
    expect(small2.calls[7]!.messages[0]!.content).toContain(
      'LITERATURE COHERENCE REFEREE',
    );
    expect(small2.calls[9]!.messages[0]!.content).toContain('CLARITY REFEREE');
  });
});

describe('deterministic checkers (7b)', () => {
  // A manuscript with real structure: duplicate Figure 1 captions, a dangling
  // Figure 9 reference, and a section reference to a missing section — the
  // xref check must find them and the findings must reach the REPORT as
  // provenance-'deterministic' comments (Python _assemble parity). The
  // abstract/body carry a number conflict for the consistency check.
  const CHECKER_MD = `# Checker Paper

## Abstract

Our mean absolute error is 3.42 across all benchmarks in this study.

## 1. Intro

Figure 1: the pipeline. See Section 4 for the ablations. Figure 9 plots the
rest. The reported mean absolute error is 4.10 in the harder split.

## References

[1] Smith, J. (2001). A paper. Journal of Papers.
`;

  function checkerDoc(): Document {
    return readMarkdown(CHECKER_MD);
  }

  it('findings reach the report as deterministic comments in their own section', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({ claims: [] }), // claimless: verify = checkers only
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      // e2ba304 (7R F1): checker findings are assemble-only — they never
      // enter the meta merge or the validate stream, so validate has no LLM
      // candidates here (challengeValidated is empty) and SKIPS entirely.
      // No validator reply is queued.
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }),
    );
    const { state, events } = await drain(
      runReview({
        doc: checkerDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );

    // the verify head emitted the sorted-kinds detail (Python format):
    // sorted kinds joined by ', ' — consistency before xref alphabetically
    const detEvent = events.find(
      (e) => e.stage === 'verify' && e.detail?.startsWith('deterministic checks: '),
    );
    expect(detEvent).toBeDefined();
    expect(detEvent!.detail).toBe('deterministic checks: consistency×1, xref×2');

    // findings persisted on the run state
    const findings = state.checkerFindings as Record<string, unknown>[];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f['provenance'] === 'deterministic')).toBe(true);
    expect(findings.some((f) => f['check'] === 'xref')).toBe(true);

    // findings JOIN the report (Python _assemble: checkerComments first) and
    // are anchored like every other comment (ids over the combined list).
    const report = state.report as import('../src/report/models').ReviewReport;
    const detComments = report.comments.filter((c) => c.provenance === 'deterministic');
    expect(detComments.length).toBe(findings.length);
    // markdown ingest has no figure artifacts pre-extraction wiring: the xref
    // check sees only the prose-embedded "Figure 1: the pipeline."
    // definition -> Figure 9 dangles, Section 4 is unregistered
    expect(detComments.some((c) => c.title === 'Reference to undefined Figure 9')).toBe(
      true,
    );
    expect(
      detComments.some(
        (c) => c.title === 'References to sections without matching headings',
      ),
    ).toBe(true);
    // section stamped from the resolved block's section path
    const fig9 = detComments.find(
      (c) => c.title === 'Reference to undefined Figure 9',
    )!;
    expect(fig9.section).toBe('1. Intro');
    // ids number the COMBINED list (checker comments come first: c000...)
    expect(report.comments[0]!.provenance).toBe('deterministic');
    expect(report.comments[0]!.id).toBe('c000');

    // e2ba304 (7R F1) meta pin: the checker findings do NOT enter the META
    // prompt anymore (assemble-only) — the meta stream carries only the
    // (empty) challenge-validated merge, and validate never runs (no LLM
    // candidates without checker findings in the stream).
    const metaCall = strong.calls.find((c) =>
      c.messages[1]!.content.startsWith('Manuscript title: Checker Paper\n\nTriage:'),
    )!;
    expect(metaCall.messages[1]!.content).not.toContain(
      'Reference to undefined Figure 9',
    );
    const validateCall = strong.calls.find((c) =>
      c.messages[0]!.content.includes('REVIEW VALIDATOR'),
    );
    expect(validateCall).toBeUndefined();
    // assemble prepends each checker title EXACTLY ONCE with deterministic
    // provenance (no meta dedupe pass touched them).
    const titles = report.comments.map((c) => c.title);
    expect(titles.filter((t) => t === 'Reference to undefined Figure 9')).toHaveLength(
      1,
    );
    const synthCall = strong.calls.find((c) =>
      c.messages[0]!.content.includes('LEAD REFEREE'),
    )!;
    expect(synthCall.messages[1]!.content).toContain(
      'Validated comments (title | severity | provenance | anchor):',
    );
  });

  it('resume with checkerFindings present: the scan is skipped (emit absent)', async () => {
    // Run once to completion, then resume the finished run: verify is
    // done-with-artifact so the stage is skipped entirely — but the DOI
    // findings coupling needs a different path: simulate a run where the
    // state carries checker findings but verify re-enters (failed verify).
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'first pass' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      // validate (7f merged stream: 4 checker findings, 0 LLM candidates)
      j({ rejected: [], comments: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }),
    );
    const first = await drain(
      runReview({
        doc: checkerDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    const resumeState = await loadRun(first.state.runId);
    const findingsBefore = (resumeState!.checkerFindings ?? []).length;
    expect(findingsBefore).toBeGreaterThan(0);

    // Resume the completed run. Every stage re-enters done-with-artifact
    // except claims (failed: empty inventory) — verify itself is done with
    // candidates, so the deterministic scan MUST NOT re-run and NO second
    // 'deterministic checks:' event may appear.
    const strong2 = new ScriptedProvider();
    strong2.queue(j({ claims: [] })); // claims re-run only
    const small2 = new ScriptedProvider();
    const second = await drain(
      runReview({
        doc: checkerDoc(),
        settings: makeSettings(),
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    const detEvents = second.events.filter(
      (e) => e.stage === 'verify' && e.detail?.startsWith('deterministic checks: '),
    );
    expect(detEvents).toHaveLength(0);
    // findings preserved exactly (no double-append)
    expect((second.state.checkerFindings ?? []).length).toBe(findingsBefore);
    // report still assembled; deterministic comments re-derive from the
    // preserved findings via checkerComments at assemble time
    const report = second.state.report as import('../src/report/models').ReviewReport;
    const detComments = report.comments.filter((c) => c.provenance === 'deterministic');
    // 4 findings: Figure 9 dangling + section-refs + number conflict + one
    // DOI resolution (bibliography unmatched entry '[2] Doe, J. (2010).' —
    // the REFERENCES fixture entry fails to match offline -> doi finding)
    expect(detComments.map((c) => c.title)).toEqual([
      'Reference to undefined Figure 9',
      'References to sections without matching headings',
      'Conflicting values for "absolute error is" (3.42 vs 4.10)',
      'Reference not resolvable in Crossref/OpenAlex',
    ]);
  });

  it('coupling: pre-seeded doi findings make verify skip the deterministic scan', async () => {
    // Python gate is `if not self.state.checker_findings` — any existing
    // findings (e.g. doi-resolution from a resumed bibliography) suppress
    // the scan. Simulate by injecting findings into the resume state.
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      j({ rejected: [], comments: [] }), // validate over the merged stream
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }),
    );
    const resumeState = await loadRun(
      (
        await drain(
          runReview({
            doc: checkerDoc(),
            settings: makeSettings(),
            providers: { strong, small },
          }),
        )
      ).state.runId,
    );
    // wipe + re-seed findings the way the bibliography doi-resolution would
    resumeState!.checkerFindings = [
      {
        check: 'doi-resolution',
        title: 'Reference not resolvable in Crossref/OpenAlex',
        message: 'phantom',
        quote: '[1] Smith',
        category: 'reference',
        severity: 0.4,
        meta: { kind: 'unmatched', score: 0 },
        provenance: 'deterministic',
      },
    ];
    const strong2 = new ScriptedProvider();
    strong2.queue(
      j({ claims: [] }), // claims re-run
      // verify re-enters too (simulate by wiping candidates + verify status)
    );
    const small2 = new ScriptedProvider();
    resumeState!.stages['verify'] = 'pending';
    resumeState!.artifacts!.candidates = [];
    const { events, state } = await drain(
      runReview({
        doc: checkerDoc(),
        settings: makeSettings(),
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    // the scan is SKIPPED: no new deterministic-checks emit, and the seeded
    // doi finding is still the ONLY checker finding
    expect(
      events.filter(
        (e) => e.stage === 'verify' && e.detail?.startsWith('deterministic checks: '),
      ),
    ).toHaveLength(0);
    expect((state.checkerFindings ?? []).length).toBe(1);
    expect((state.checkerFindings ?? [])[0]!['check']).toBe('doi-resolution');
    // and the doi finding still reaches the report as a comment
    const report = state.report as import('../src/report/models').ReviewReport;
    const detComments = report.comments.filter((c) => c.provenance === 'deterministic');
    expect(detComments.map((c) => c.comment)).toEqual(['phantom']);
  });

  // e2ba304 (7R F1): origin/main test_yield.py ports — the checker findings
  // are ASSEMBLE-ONLY (meta must not dissolve them, assemble prepends them
  // fresh with provenance intact).
  it('port: meta does not dissolve checker comments (test_meta_does_not_dissolve_checker_comments)', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: checkerDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    const metaCall = strong.calls.find((c) =>
      c.messages[1]!.content.startsWith('Manuscript title: Checker Paper\n\nTriage:'),
    )!;
    const metaUser = metaCall.messages[1]!.content;
    // NO checker finding title, quote, or provenance tag rides the meta
    // prompt: the merge is list(validated) ONLY.
    expect(metaUser).not.toContain('Reference to undefined Figure 9');
    expect(metaUser).not.toContain('References to sections without matching headings');
    expect(metaUser).not.toContain('"provenance": "deterministic"');
    // and meta's OUTPUT cannot have dissolved anything — every finding
    // survives to the report verbatim, exactly once.
    const report = state.report as import('../src/report/models').ReviewReport;
    const titles = report.comments.map((c) => c.title);
    for (const t of [
      'Reference to undefined Figure 9',
      'References to sections without matching headings',
      'Conflicting values for "absolute error is" (3.42 vs 4.10)',
    ]) {
      expect(titles.filter((x) => x === t)).toHaveLength(1);
    }
  });

  it('port: assemble prepends checker comments with provenance (test_assemble_appends_checker_comments_with_provenance)', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      // one logical claim so the claim worker (wholePaperPasses=false: no
      // whole-paper verifier) produces the LLM candidate — the ASSEMBLE order
      // is then observable: the LLM comment must come AFTER the
      // deterministic block (Python finalComments = checker + draft.comments).
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor: 'See Section 4 for the ablations',
            section: '1. Intro',
          },
        ],
      }),
      // claim worker (logical -> strong)
      j({
        comments: [
          {
            quote: 'See Section 4 for the ablations',
            message: 'Section 4 is referenced but absent',
            score: 0.5,
          },
        ],
      }),
      // Front-matter challenger keeps the claim (no drops); the whole-paper
      // challenger then validates it through — the candidate must SURVIVE
      // challenge for the assemble order to be observable.
      j({ validated: [], new_comments: [] }),
      j({
        validated: [
          {
            paragraph_anchor: 'See Section 4 for the ablations',
            quote: 'See Section 4 for the ablations',
            message: 'Section 4 is referenced but absent',
            score: 0.5,
          },
        ],
        new_comments: [],
      }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }),
      // validator: challengeValidated is non-empty now (the whole-paper
      // challenger kept the claim worker's candidate) — it keeps everything.
      j({ validated: [0], rejected: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: checkerDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    // deterministic block FIRST, LLM comments after (assemble prepend)
    const firstLlm = report.comments.findIndex((c) => c.provenance !== 'deterministic');
    expect(firstLlm).toBeGreaterThan(0);
    expect(
      report.comments.slice(0, firstLlm).every((c) => c.provenance === 'deterministic'),
    ).toBe(true);
    // every deterministic comment keeps quote + provenance (upstream pins)
    for (const c of report.comments.filter((x) => x.provenance === 'deterministic')) {
      expect(c.quote).not.toBe('');
      expect(c.title).not.toBe('');
    }
    // ids number the COMBINED list in order (c000.. deterministic, then LLM)
    expect(report.comments[0]!.id).toBe('c000');
    expect(report.comments[firstLlm]!.id).toBe(`c${String(firstLlm).padStart(3, '0')}`);
  });
});

describe('runReview malformed-envelope tolerance (fe463f2 + 61f5822)', () => {
  it('whole-paper challenger returning a bare validated list still yields comments', async () => {
    const anchor = 'We prove the main theorem in this paper';
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor,
            section: 'Introduction',
          },
        ],
      }),
      // claim worker (logical -> strong): one candidate
      j({ comments: [{ quote: anchor, message: 'bare list candidate', score: 0.6 }] }),
      // Intro challenger: normal envelope, drops nothing new
      j({ validated: [], new_comments: [] }),
      // Methods challenger
      j({ validated: [], new_comments: [] }),
      // whole-paper challenger: BARE LIST (fe463f2), with a non-dict item (61f5822)
      j([
        {
          paragraph_anchor: anchor,
          quote: anchor,
          message: 'kept from bare list',
          score: 0.7,
        },
        'a bare string item',
        42,
      ]),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      // validator keeps everything
      j({ validated: [0], rejected: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    expect(state.stages['challenge']).toBe('done');
    const report = state.report as import('../src/report/models').ReviewReport;
    const msgs = report.comments.map((c) => c.comment);
    expect(msgs).toContain('kept from bare list');
    // the non-dict items never became comments
    expect(msgs).not.toContain('a bare string item');
  });

  it('section challenger non-dict validated/new_comments items are skipped', async () => {
    const anchor = 'We prove the main theorem in this paper';
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor,
            section: 'Introduction',
          },
        ],
      }),
      j({}),
      j({ comments: [{ quote: anchor, message: 'survivor', score: 0.6 }] }),
      // Intro challenger: validated carries non-dict junk; new_comments too
      j({
        validated: [
          'garbage string',
          7,
          {
            paragraph_anchor: anchor,
            quote: anchor,
            message: 'real one',
            score: 0.8,
            verdict: 'kept',
          },
        ],
        new_comments: [
          'junk',
          {
            paragraph_anchor: anchor,
            quote: anchor,
            message: 'fresh find',
            score: 0.5,
          },
        ],
      }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: '## synth' }), // synthesis (7f)
      j({ validated: [0], rejected: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    expect(state.stages['challenge']).toBe('done');
    const report = state.report as import('../src/report/models').ReviewReport;
    const msgs = report.comments.map((c) => c.comment);
    expect(msgs).toContain('real one');
    expect(msgs).toContain('fresh find');
    expect(msgs).not.toContain('garbage string');
    expect(msgs).not.toContain('junk');
  });
});
