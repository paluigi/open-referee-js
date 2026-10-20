import { beforeEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline/orchestrator';
import type { StageProgress } from '../src/pipeline/orchestrator';
import type { RunState, StageEvent } from '../src/pipeline/state';
import { listRuns } from '../src/runs/store';
import type { Document } from '../src/ingestion/document';
import { readMarkdown } from '../src/ingestion/readers_md';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
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
      j({ selected: [], missing_references: [] }),
      // verify: cl001 (theorem_proof, central) goes to the strong role;
      // cl002 (numerical) goes to small (its response is queued separately)
      j({ comments: [] }),
      // challenge: 2 section challengers (Methods claims the anchor) +
      // whole-paper challenger (nothing new)
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

      // validator: keep index 0
      j({ validated: [0], rejected: [], reasons: 'ok' }),
    );
    const small = new ScriptedProvider();
    small.queue(
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
      }),
    ); // numerical claim -> small role
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
      'verify',
      'challenge',
      'meta',
      'validate',
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

    // strong provider: triage, inventory, survey, theorem_proof worker,
    // 2 section challengers, whole-paper challenger, meta, validator = 9
    // (wholePaperPasses=false: no whole-paper VERIFIER; the whole-paper
    // CHALLENGER is part of the challenge stage and always runs)
    expect(strong.calls).toHaveLength(9);
    expect(strong.calls[0]!.spec.model).toBe('m-strong');
    expect(strong.calls[0]!.spec.temperature).toBe(0.2);
    expect(strong.calls[0]!.spec.maxTokens).toBe(4096);
    // small role got the numerical claim worker
    expect(small.calls).toHaveLength(1);
    expect(small.calls[0]!.messages[1]!.content).toContain('[cl002]');

    // verify progress carries unitsDone/unitsTotal per claim
    const progress = progressCalls.filter((p) => p !== undefined);
    expect(progress.some((p) => p!.unitsTotal === 2)).toBe(true);

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
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments).toHaveLength(0);
    // triage ran; the claims budget check tripped before any inventory call
    expect(strong.calls).toHaveLength(1);
    expect(state.stages['claims']).toBe('failed');
    expect(state.stages['survey']).toBe('skipped');
    expect(state.stages['verify']).toBe('skipped');
    expect(state.stages['meta']).toBe('skipped');
    expect(state.stages['validate']).toBe('skipped');
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
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small: new ScriptedProvider() },
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
      j({ validated: [], new_comments: [] }),
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
      j({ overall_feedback: 'report' }),
      // validator sees the POST-gate list (2 comments) and keeps both
      j({ validated: [0, 1], rejected: [] }),
    );
    const small = new ScriptedProvider();
    // small defends each comment before the strong adjudicator rules
    small.queue(
      j({ defense: 'it is fine', defense_strength: 'strong' }),
      j({ defense: 'overstated', defense_strength: 'weak' }),
      j({ defense: 'no case', defense_strength: 'none' }),
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
    // defense on small (3 calls), adjudication on strong
    expect(small.calls).toHaveLength(3);
    expect(small.calls[0]!.messages[0]!.content).toContain("AUTHORS' DEFENSE COUNSEL");
  });
});

describe('runReview malformed JSON', () => {
  it('fails the stage, sets partial, and still completes the run', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      'this is not json at all', // triage: garbage — TS triage/meta/validate use plain callJson (no repair retry); Python repairs there too but TS hasn't since Stage 1 -> failed
      'no json {{{ here', // inventory: garbage
      'again {{{ nope', // inventory repair retry: garbage -> claims failed
      'survey {{{ nope', // survey: garbage -> survey failed
      // challengers + whole-paper challenger run claimless
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      'also {{{ not json', // meta: garbage -> meta failed (no repair: meta uses callJson)
      j({ validated: [], rejected: [] }), // validator — never reached (no candidates)
    );
    const settings = makeSettings();
    const { state, events } = await drain(
      runReview({
        doc: makeDoc(),
        settings,
        providers: { strong, small: new ScriptedProvider() },
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
      // challengers run with empty candidate list, hunter adds nothing
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ validated: [], rejected: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small: new ScriptedProvider() },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments).toHaveLength(0);
    expect(state.stages['verify']).toBe('failed');
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
    // + survey + 2 challengers + whole-paper challenger + meta = 7 strong calls
    // (validator skipped: no candidates survive a claimless run)
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({ claims: [] }), // inventory empty -> claims stage failed, pipeline continues
      j({}),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
    );
    await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small: new ScriptedProvider() },
      }),
    );
    expect(strong.calls).toHaveLength(7);

    // lenses on, whole-paper off: statistical_content 'regression' ->
    // prose + empirical + lit = 3 lenses x 2 sections = 6 SMALL calls
    const strong2 = new ScriptedProvider();
    strong2.queue(
      j({ summary: 's', statistical_content: 'regression' }),
      j({ claims: [] }),
      j({}),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }), // whole-paper challenger (always runs)
      j({ overall_feedback: 'ok' }),
    );
    const small2 = new ScriptedProvider();
    for (let i = 0; i < 6; i++) small2.queue(j({ comments: [] }));
    await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings({
          review: { perSectionLenses: true, wholePaperPasses: false },
        }),
        providers: { strong: strong2, small: small2 },
      }),
    );
    expect(small2.calls).toHaveLength(6);
    // lens order: prose (per lens-outer loop), then empirical, then lit
    expect(small2.calls[0]!.messages[0]!.content).toContain(
      'INTERNAL COHERENCE REFEREE',
    );
    expect(small2.calls[2]!.messages[0]!.content).toContain(
      'STATISTICS AND ECONOMETRICS REFEREE',
    );
    expect(small2.calls[4]!.messages[0]!.content).toContain(
      'LITERATURE COHERENCE REFEREE',
    );
  });
});
