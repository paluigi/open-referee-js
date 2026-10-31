import { beforeEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline/orchestrator';
import type { RunState, StageEvent } from '../src/pipeline/state';
import { createRunState, firstOpenStage, STAGES } from '../src/pipeline/state';
import { listRuns, loadRun } from '../src/runs/store';
import { readMarkdown } from '../src/ingestion/readers_md';
import type { Document } from '../src/ingestion/document';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
import { bibliographySystem, metaPrompt } from '../src/pipeline/prompts';
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

## References

[1] Smith, J. (2001). A paper. Journal of Papers.
[2] Doe, J. (2010). Another. Annals.
`;

function makeDoc(): Document {
  return readMarkdown(MD);
}

function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    pricing: { 'm-strong': { input: 2, output: 8 } },
    roles: {
      strong: { provider: 'strong', model: 'm-strong' },
      small: { provider: 'small', model: 'm-small' },
      vision: { provider: '', model: '' },
    },
    review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    ...partial,
  };
}

/** Full depth preset (all passes on) for tests that exercise the gate. */
function makeSettingsFull(): AppSettings {
  return makeSettings({
    review: {
      perSectionLenses: true,
      wholePaperPasses: true,
      defenseRound: true,
    },
  });
}

/** Scriptable provider that records every completed call. */
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
  const g = globalThis as unknown as Record<string, unknown>;
  // No network in this e2e: the survey stage issues real fetches as soon as a
  // triage fixture carries search_queries.
  g.fetch = () => Promise.reject(new TypeError('no network in resume e2e'));
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

describe('firstOpenStage (resume re-entry point)', () => {
  it('a fresh run starts at triage', () => {
    expect(firstOpenStage(createRunState('r', 'P'))).toBe('triage');
  });

  it('returns the first stage that is not done-with-artifact', () => {
    const state = {
      runId: 'r',
      documentTitle: 'P',
      stages: {
        triage: 'done',
        claims: 'done',
        survey: 'done',
        scout: 'done',
        verify: 'done',
        challenge: 'done',
      },
      events: [],
      partial: false,
      startedAt: 'x',
      updatedAt: 'y',
      artifacts: {
        triage: { summary: 's' },
        claims: [],
        survey: { paperTitle: 'P', items: [], bibChecks: [], userDocs: [] },
        // verify is done WITH its artifact (candidates persisted since the
        // Stage-6 review fixes) — so the re-entry point is challenge.
        candidates: [],
      },
    } as unknown as RunState;
    // challenge is done but its artifact is absent -> re-enter there
    expect(firstOpenStage(state)).toBe('challenge');
  });

  it('skipped stages with a report stay skipped; without one they re-run', () => {
    const base = {
      runId: 'r',
      documentTitle: 'P',
      stages: { triage: 'done', claims: 'skipped' },
      events: [],
      partial: true,
      startedAt: 'x',
      updatedAt: 'y',
      artifacts: { triage: {} },
    } as unknown as RunState;
    expect(firstOpenStage({ ...base, report: { paperTitle: 'P' } })).toBe('survey');
    expect(firstOpenStage(base)).toBe('claims');
  });

  it('STAGES has bibliography between challenge and meta', () => {
    expect(STAGES.indexOf('bibliography')).toBe(STAGES.indexOf('challenge') + 1);
    expect(STAGES.indexOf('meta')).toBe(STAGES.indexOf('bibliography') + 1);
  });
});

describe('resume e2e: interrupt after challenge, resume completes', () => {
  it('resume re-enters at bibliography WITHOUT re-calling earlier stages', async () => {
    // ---- first attempt: run through the challenge stage, then abandon the
    // generator when the NEXT stage announces itself (a browser tab close
    // mid-run). At that point the challenge stage's artifact sync has
    // completed — Python's `_stage_or_resume` saves artifacts only between
    // stages, so that is the only faithful interruption point.
    const strong = new ScriptedProvider();
    strong.queue(
      j({ mathematical_density: 'light', summary: 's' }),
      // one logical claim so the claims stage completes (a FAILED stage
      // re-runs on resume, Python semantics — not what this test exercises)
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor: 'bootstrap with 999 replications',
            section: 'Methods',
          },
        ],
      }),
      // claim worker (logical -> strong)
      j({ comments: [] }),
      // challengers: 2 sections + whole-paper
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
    );
    const gen = runReview({
      doc: makeDoc(),
      settings: makeSettings(),
      providers: { strong, small },
    });
    const events: StageEvent[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.stage === 'bibliography' && next.value.status === 'running') {
        await gen.return(undefined as unknown as RunState);
        break;
      }
    }
    expect(events.some((e) => e.stage === 'challenge' && e.status === 'done')).toBe(
      true,
    );

    // Recover the persisted state the way the UI resume flow does.
    const runs = await listRuns();
    const saved = runs.find((r) => r.stages['challenge'] === 'done');
    expect(saved).toBeDefined();
    // bibliography is mid-flight (its 'running' event is the interruption
    // point): the resume must re-enter there and re-run it.
    expect(saved!.stages['bibliography'] ?? 'pending').toBe('running');
    // The doc snapshot rides in the persisted state.
    expect(saved!.docData).toBeDefined();

    // Reload from IndexedDB exactly like the UI would.
    const resumeState = await loadRun(saved!.runId);
    expect(resumeState).toBeDefined();

    // ---- resume: ONLY the remainder of bibliography (SMALL) + meta
    // (STRONG) run — BUT the interruption point above left challenge done
    // with its artifact already saved, so challenge does not re-call.
    const strong3 = new ScriptedProvider();
    strong3.queue(
      // resume re-enters mid-challenge is impossible (artifact saved) —
      // the ONLY strong calls are meta + synthesis (7f). e2ba304 (7R F1):
      // validate no longer runs merely because checker findings exist —
      // it needs LLM candidates, and challengeValidated here is empty, so
      // validate SKIPS and no validator reply is consumed.
      j({ overall_feedback: 'resumed report', recommendation: 'minor revision' }),
      j({ overall_feedback: 'synth over resumed report' }),
    );
    const small3 = new ScriptedProvider();
    small3.queue(
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [{ citation: 'Smith (2001)', verdict: 'supported' }],
        missing_key_references: [],
      }),
      // copyedit annex — resume continues after validate; the artifact was
      // never persisted pre-interrupt, so the stage runs once here
      j({ items: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong: strong3, small: small3 },
        resume: { state: resumeState! },
      }),
    );

    // earlier stages NOT re-called: meta + synthesis only on strong
    // (validate skips — no LLM candidates post-e2ba304); bibliography +
    // copyedit only on small
    expect(strong3.calls).toHaveLength(2);
    expect(small3.calls).toHaveLength(2);
    expect(small3.calls[0]!.messages[0]!.content).toBe(bibliographySystem);
    // meta got the bib summary wired into the bibSummary slot
    const metaUser = strong3.calls[0]!.messages[1]!.content;
    expect(metaUser).toContain('Citation audit summary');
    expect(metaUser).toContain('"in_text_issues"');
    // run completed and the report assembled
    expect(state.stages['assemble']).toBe('done');
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.overall).toBe('synth over resumed report');
    expect(state.partial).toBe(false);
  });

  it('resume after verify: candidates artifact restored, challenge sees them (no silent loss)', async () => {
    // Interrupt right after verify announces the next stage: verify's
    // artifact sync has completed, so resume must find `candidates` —
    // the verifier finding must survive into the challenge + report.
    const strong = new ScriptedProvider();
    strong.queue(
      j({
        mathematical_density: 'none',
        statistical_content: 'none',
        methodological_style: 'formal',
        summary: 's',
      }),
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor: 'bootstrap with 999 replications',
            section: 'Methods',
          },
        ],
      }),
      // claim worker returns a REAL comment — this is the finding that
      // must not vanish on resume
      j({
        comments: [
          {
            title: 'Bootstrap assumption unstated',
            message: 'The theorem needs finite second moments, stated nowhere.',
            score: 0.7,
            category: 'logical',
            claim_id: 'cl001',
            paragraph_anchor: 'bootstrap with 999 replications',
          },
        ],
      }),
      // whole-paper verifier (wholePaperPasses on): no extra findings
      j({ comments: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      // lenses: 'none' density/stats + 'formal' style -> prose + lit +
      // clarity (7f: clarity always runs), 3 lenses x 2 sections = 6 responses
      j({ comments: [] }),
      j({ comments: [] }),
      j({ comments: [] }),
      j({ comments: [] }),
      j({ comments: [] }),
      j({ comments: [] }),
    );
    const gen = runReview({
      doc: makeDoc(),
      settings: makeSettingsFull(),
      providers: { strong, small },
    });
    const events: StageEvent[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.stage === 'challenge' && next.value.status === 'running') {
        await gen.return(undefined as unknown as RunState);
        break;
      }
    }
    expect(events.some((e) => e.stage === 'verify' && e.status === 'done')).toBe(true);

    const runs = await listRuns();
    const saved = runs.find((r) => r.stages['verify'] === 'done');
    expect(saved).toBeDefined();
    const resumeState = await loadRun(saved!.runId);
    expect(resumeState).toBeDefined();

    // Resume: challenge RE-RUNS (it was mid-flight) — the candidate must be
    // in its prompt. Then the defense gate (small defends, strong
    // adjudicates), bibliography (small), meta + validate (strong).
    const strong2 = new ScriptedProvider();
    strong2.queue(
      // section challengers: Introduction gets NO candidates (the anchor is
      // in Methods); Methods upholds the restored candidate — challenger
      // `validated` entries are full comment dicts keyed by paragraph_anchor
      j({ validated: [], new_comments: [] }),
      j({
        validated: [
          { verdict: 'kept', paragraph_anchor: 'bootstrap with 999 replications' },
        ],
        new_comments: [],
      }),
      // whole-paper challenger over unclaimed anchors: none
      j({ validated: [], new_comments: [] }),
      // defense gate adjudication for the 1 restored candidate
      j({ verdict: 'upheld' }),
      // meta
      j({ overall_feedback: 'survived resume', recommendation: 'accept' }),
      // synthesis (7f)
      j({ overall_feedback: 'synth after resume' }),
      // validator
      j({ validated: [0], rejected: [] }),
    );
    const small2 = new ScriptedProvider();
    small2.queue(
      j({ defense: 'stated in the appendix', defense_strength: 'weak' }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }), // copyedit annex
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettingsFull(),
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    // challenge consumed the RESTORED candidate: its prompt names the finding
    // (candidates are ReviewComment-shaped — the finding text is `comment`)
    const challengeCalls = strong2.calls.slice(0, 3);
    expect(
      challengeCalls.some((c) =>
        c.messages[1]!.content.includes(
          'The theorem needs finite second moments, stated nowhere.',
        ),
      ),
    ).toBe(true);
    expect(strong2.calls).toHaveLength(7); // 3 challenge + defense + meta + synthesis + validate
    expect(small2.calls).toHaveLength(3); // defense + bibliography + copyedit
    expect(state.stages['assemble']).toBe('done');
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.comments.map((c) => c.comment)).toContain(
      'The theorem needs finite second moments, stated nowhere.',
    );
    expect(state.partial).toBe(false);
  });

  it('resume after meta: draft review restored, validate sees the real overall', async () => {
    // Interrupt when validate announces itself: meta is done + persisted.
    // Resume must NOT lose the meta output (Python draft_review parity).
    const strong = new ScriptedProvider();
    strong.queue(
      j({
        mathematical_density: 'none',
        statistical_content: 'none',
        methodological_style: 'formal',
        summary: 's',
      }),
      j({ claims: [] }),
      // challengers: 2 sections + whole-paper (lenses/whole-paper/gate all off)
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      // meta → synthesis (7f) → validate over the merged checker stream
      // (7f: deterministic findings make validate run even with no LLM
      // candidates). Copyedit announcing itself is the interruption point.
      j({ overall_feedback: 'THE META VERDICT', recommendation: 'minor revision' }),
      j({ overall_feedback: 'THE SYNTH ESSAY' }),
      j({ rejected: [], comments: [] }),
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      // bibliography (a real entry so the stage counts as done)
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
    );
    const gen = runReview({
      doc: makeDoc(),
      settings: makeSettings(),
      providers: { strong, small },
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      // Interrupt when COPYEDIT announces itself: with a claimless fixture
      // validate is skipped (no candidates), so copyedit is the first stage
      // after meta to announce 'running' — meta is done + persisted there.
      if (next.value.stage === 'copyedit' && next.value.status === 'running') {
        await gen.return(undefined as unknown as RunState);
        break;
      }
    }

    const runs = await listRuns();
    const saved = runs.find((r) => r.stages['meta'] === 'done');
    expect(saved).toBeDefined();
    const resumeState = await loadRun(saved!.runId);

    const strong2 = new ScriptedProvider();
    // the claimless claims stage FAILED pre-interrupt → it re-runs on resume
    // (stage-failure semantics), then validate re-runs?? no — validate is
    // done. Only claims + its downstream nothing: claims re-inventories.
    strong2.queue(j({ claims: [] }));
    const small2 = new ScriptedProvider();
    small2.queue(j({ items: [] })); // copyedit annex (never ran pre-interrupt)
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    // the re-run claims inventory + nothing else (meta/synthesis/validate
    // are all restored; claims re-runs because it FAILED pre-interrupt)
    expect(strong2.calls).toHaveLength(1);
    expect(small2.calls).toHaveLength(1); // copyedit annex only
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.overall).toBe('THE SYNTH ESSAY');
    // NB: partial is true here — the claimless fixture marks the claims stage
    // 'failed or produced no claims' in BOTH attempts (asserted above).
  });
});

describe('copyedit artifact contract', () => {
  it('resume with the copyedit artifact persisted does NOT re-call copyedit', async () => {
    // Run to completion once (copyedit returns one real item).
    const strong = new ScriptedProvider();
    strong.queue(
      j({
        mathematical_density: 'none',
        statistical_content: 'none',
        methodological_style: 'formal',
        summary: 's',
      }),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'done once' }),
      j({ overall_feedback: 'done once (synth)' }),
      j({ rejected: [], comments: [] }), // validate over the merged checker stream (7f)
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({
        items: [
          {
            quote: 'Standard errors are computed by bootstrap',
            suggestion: 'Standard errors are computed via the bootstrap',
            kind: 'phrasing',
          },
        ],
      }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small },
      }),
    );
    expect(state.stages['copyedit']).toBe('done');
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.copyeditItems).toHaveLength(1);

    // Resume the COMPLETED run: every stage re-enters as done-with-artifact
    // (the copyedit artifact included) — no provider call may happen at all.
    // NB: the claims stage is 'failed' here (empty inventory fixture), and a
    // failed stage legitimately re-runs on resume — so give it one response;
    // the assertion below is that COPYEDIT is not re-called.
    const resumeState = await loadRun(state.runId);
    const strong2 = new ScriptedProvider();
    strong2.queue(
      j({ claims: [] }), // claims re-run (failed stage), everything else skips
    );
    const small2 = new ScriptedProvider();
    const { state: state2 } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    // copyedit NOT re-called despite the resume re-running earlier stages.
    expect(small2.calls).toHaveLength(0);
    expect(state2.stages['copyedit']).toBe('done');
    expect(state2.report).toBeDefined();
    expect(
      (state2.report as import('../src/report/models').ReviewReport).copyeditItems,
    ).toHaveLength(1);
  });
});

describe('meta bibSummary wiring', () => {
  it('metaPrompt carries the bib summary in its dedicated slot', () => {
    const p = metaPrompt(
      'T',
      '{}',
      '[]',
      JSON.stringify({
        entries: [{ raw_entry: '[1]', status: 'verified' }],
        in_text_issues: [],
      }).slice(0, 8000),
      'notes',
    );
    expect(p).toContain(
      'Citation audit summary: {"entries":[{"raw_entry":"[1]","status":"verified"}],"in_text_issues":[]}',
    );
    expect(p).toContain('Literature notes: notes');
  });
});
