import { beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.fetch = () => Promise.reject(new TypeError('no network in two-phase tests'));
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

/**
 * Scriptable provider with a reasoning-capability flag (Stage 7d two-phase
 * tests). Records every call's spec so the phase ladder is observable.
 */
class ReasoningStub implements ChatProvider {
  readonly calls: { messages: ChatMessage[]; spec: ModelSpec }[] = [];
  private script: (string | Error)[] = [];

  constructor(public readonly supportsReasoning: boolean) {}

  queue(...contents: (string | Error)[]): void {
    this.script.push(...contents);
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    const item = this.script.shift();
    if (item === undefined) throw new Error('reasoning stub queue empty');
    if (item instanceof Error) throw item;
    this.calls.push({ messages, spec });
    return {
      content: item,
      usage: { promptTokens: 10, completionTokens: 5 },
      model: spec.model,
    };
  }

  close(): void {}
}

function j(obj: unknown): string {
  return JSON.stringify(obj);
}

const MD = `# Two Phase Paper

## Introduction

We prove the main theorem in this paper. The estimator uses bootstrap with
999 replications and stratification by the treatment assignment variable.
`;

describe('two-phase JSON (Stage 7d) — ladder sequencing', () => {
  it('low-effort retry fires on empty content and recovers with valid JSON', async () => {
    const { runReview } = await import('../src/pipeline/orchestrator');
    const { readMarkdown } = await import('../src/ingestion/readers_md');
    const { DEFAULT_SETTINGS } = await import('../src/config/schema');

    const strong = new ReasoningStub(true);
    strong.queue(''); // triage: reasoning ate the budget (empty content)
    strong.queue(j({ mathematical_density: 'light', summary: 'recovered' })); // low-effort retry: valid JSON
    strong.queue(j({ claims: [] })); // inventory
    strong.queue(j({})); // inventory repair path unused; challengers claimless
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ overall_feedback: 'ok' }));
    strong.queue(j({ overall_feedback: 'ok' })); // synthesis (7f)
    const small = new ReasoningStub(false);
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
    );
    small.queue(j({ items: [] }));

    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      pricing: { 'm-strong': { input: 2, output: 8 } },
      roles: {
        strong: { provider: 'strong', model: 'm-strong' },
        small: { provider: 'small', model: 'm-small' },
        vision: { provider: '', model: '' },
      },
      review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    };
    const events: unknown[] = [];
    const { state } = await (async () => {
      const gen = runReview({
        doc: readMarkdown(MD),
        settings,
        providers: { strong, small },
        onEvent: (e) => events.push(e),
      });
      for (;;) {
        const next = await gen.next();
        if (next.done) return { state: next.value };
      }
    })();

    // triage recovered on the low-effort arm: its spec carries the effort hint
    expect(strong.calls[1]!.spec.reasoningEffort).toBe('low');
    // the retry re-sends the SAME messages (Python: same call under the control)
    expect(strong.calls[1]!.messages[1]!.content).toBe(
      strong.calls[0]!.messages[1]!.content,
    );
    expect(state.stages['triage']).toBe('done');
  });

  it('full two-phase fires when the low-effort arm also returns empty', async () => {
    const { runReview } = await import('../src/pipeline/orchestrator');
    const { readMarkdown } = await import('../src/ingestion/readers_md');
    const { DEFAULT_SETTINGS } = await import('../src/config/schema');

    const strong = new ReasoningStub(true);
    strong.queue(''); // single call: empty (exhaustion signature)
    strong.queue(''); // low-effort control: still empty
    strong.queue(
      'The paper claims X; I must examine the bootstrap assumptions carefully.', // phase 1: free-form reasoning
    );
    strong.queue(j({ mathematical_density: 'light', summary: 'two-phase' })); // phase 2: emission
    strong.queue(j({ claims: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ overall_feedback: 'ok' }));
    strong.queue(j({ overall_feedback: 'ok' })); // synthesis (7f)
    const small = new ReasoningStub(false);
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
    );
    small.queue(j({ items: [] }));

    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      pricing: { 'm-strong': { input: 2, output: 8 } },
      roles: {
        strong: { provider: 'strong', model: 'm-strong' },
        small: { provider: 'small', model: 'm-small' },
        vision: { provider: '', model: '' },
      },
      review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    };
    const gen = runReview({
      doc: readMarkdown(MD),
      settings,
      providers: { strong, small },
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
    }

    // calls[2] is phase 1: raised 24k reasoning budget, no effort hint
    expect(strong.calls[2]!.spec.callMaxTokens).toBe(24_576);
    expect(strong.calls[2]!.spec.reasoningEffort).toBeUndefined();
    // calls[3] is phase 2: emission system prompt carries the analysis and
    // the low-effort hint
    expect(strong.calls[3]!.spec.reasoningEffort).toBe('low');
    const sys = strong.calls[3]!.messages[0]!.content;
    expect(sys).toContain('You are given your own prior analysis of the task');
    const user = strong.calls[3]!.messages[1]!.content;
    expect(user).toContain('Your prior analysis:');
    expect(user).toContain('bootstrap assumptions carefully');
    expect(user).toContain('output ONLY the required JSON now');
    // both phase records booked under the original call type (triage):
    // the ledger sees four 'triage'-tagged records (single, low-effort,
    // phase 1, phase 2). 7d review (C4): assert the callType tail on the
    // run state — the ledger records persist there.
    const { loadRun, listRuns } = await import('../src/runs/store');
    const runs = await listRuns();
    const saved = await loadRun(runs[0]!.runId);
    const triageTypes = (saved!.ledgerCalls ?? [])
      .filter((c) => c.callType === 'triage')
      .map((c) => c.role);
    expect(triageTypes).toEqual(['strong', 'strong', 'strong', 'strong']);
  });

  it('non-reasoning stubs never escalate: one call per stage, queues stable', async () => {
    const { runReview } = await import('../src/pipeline/orchestrator');
    const { readMarkdown } = await import('../src/ingestion/readers_md');
    const { DEFAULT_SETTINGS } = await import('../src/config/schema');

    const strong = new ReasoningStub(false);
    strong.queue(j({ summary: 's' }));
    strong.queue(j({ claims: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ validated: [], new_comments: [] }));
    strong.queue(j({ overall_feedback: 'ok' }));
    strong.queue(j({ overall_feedback: 'ok' })); // synthesis (7f)
    const small = new ReasoningStub(false);
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
    );
    small.queue(j({ items: [] }));

    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      pricing: { 'm-strong': { input: 2, output: 8 } },
      roles: {
        strong: { provider: 'strong', model: 'm-strong' },
        small: { provider: 'small', model: 'm-small' },
        vision: { provider: '', model: '' },
      },
      review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    };
    const gen = runReview({
      doc: readMarkdown(MD),
      settings,
      providers: { strong, small },
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
    }
    // pre-7d behavior + one synthesis call (7f): triage + inventory +
    // 1 section challenger + whole-paper challenger + meta + synthesis
    expect(strong.calls).toHaveLength(6);
    expect(strong.calls.every((c) => c.spec.reasoningEffort === undefined)).toBe(true);
    expect(strong.calls.every((c) => c.spec.callMaxTokens === undefined)).toBe(true);
  });
});

// --------------------------------------------------- c628796 regression --
// A provider that never produces JSON must surface LLMError (stages catch it
// and degrade), never a raw parse failure that kills the run.

describe('JSON-repair failure raises LLMError (c628796)', () => {
  it('exhausted ladder returns kind llm_error from the repair tail', async () => {
    const strong = new ReasoningStub(false);
    strong.queue('prose once'); // triage: garbage...
    strong.queue('prose twice — still not json'); // ...repair: garbage -> triage failed
    strong.queue('no json {{{ here'); // inventory: garbage...
    strong.queue('again {{{ nope'); // ...repair: garbage -> claims failed
    // challengers run claimless: each consumes 2 queue entries (garbage +
    // repair) and degrades per section
    strong.queue('challenger {{{ garbage');
    strong.queue('challenger repair {{{ garbage');
    strong.queue('whole-paper {{{ garbage');
    strong.queue('whole-paper repair {{{ garbage');
    strong.queue('meta {{{ garbage'); // meta: garbage...
    strong.queue('meta repair {{{ garbage'); // ...repair: garbage -> meta failed
    // Drive the ladder through runReview: every stage degrades (LLMError from
    // callJson -> stage failed), the run never crashes.
    const { runReview } = await import('../src/pipeline/orchestrator');
    const { readMarkdown } = await import('../src/ingestion/readers_md');
    const { DEFAULT_SETTINGS } = await import('../src/config/schema');
    const small = new ReasoningStub(false);
    small.queue('survey {{{ garbage'); // surveyor: garbage (survey runs even
    // after triage failed — queue a garbage + repair pair)
    small.queue('survey repair {{{ garbage');
    small.queue(j({ items: [] })); // copyedit annex
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      pricing: { 'm-strong': { input: 2, output: 8 } },
      roles: {
        strong: { provider: 'strong', model: 'm-strong' },
        small: { provider: 'small', model: 'm-small' },
        vision: { provider: '', model: '' },
      },
      review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    };
    const gen = runReview({
      doc: readMarkdown(MD),
      settings,
      providers: { strong, small },
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
    }
    // repair replay carries the Python repair suffix
    expect(strong.calls[1]!.messages[1]!.content).toContain(
      'Your previous reply was not valid JSON',
    );
    expect(strong.calls).toHaveLength(10);
  });
});
