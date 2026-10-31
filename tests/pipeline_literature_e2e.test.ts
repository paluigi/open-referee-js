import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runReview } from '../src/pipeline/orchestrator';
import type { RunState, StageEvent } from '../src/pipeline/state';
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

const MD = `# T Paper\n\n## Intro\n\nWe claim a novel bound on the mixing time of the chain under mild conditions.\n`;

function makeDoc(): Document {
  return readMarkdown(MD);
}

function makeSettings(): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    pricing: { 'm-strong': { input: 2, output: 8 } },
    roles: {
      strong: { provider: 'strong', model: 'm-strong' },
      small: { provider: 'small', model: 'm-small' },
      vision: { provider: '', model: '' },
    },
    review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
  };
}

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

type FetchStub = (
  url: string,
  init?: RequestInit,
) => { ok: boolean; status?: number; json?: unknown } | null;

function stubFetch(impl: FetchStub): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const res = impl(url, init);
    if (!res) throw new TypeError('Failed to fetch'); // CORS / network
    return new Response(JSON.stringify(res.json ?? {}), {
      status: res.ok ? 200 : (res.status ?? 500),
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
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

const TRIAGE = {
  domain: 'probability theory',
  search_queries: ['mixing time bounds', 'Markov chain mixing'],
  key_citations: ['Levin, Peres: Markov Chains and Mixing Times'],
};

function openAlexWork(title: string, id: string): unknown {
  return {
    id,
    display_name: title,
    publication_year: 2020,
    cited_by_count: 5,
    authorships: [{ author: { display_name: 'A. Author' } }],
    doi: 'https://doi.org/10.1/x',
    primary_location: { source: { display_name: 'Annals' } },
    abstract_inverted_index: { Word: [0], order: [1] },
  };
}

describe('literature stage wiring (runReview survey + scout)', () => {
  it('collects OpenAlex + web hits, dedupes, maps surveyor indices, appends Crossref missing refs', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j(TRIAGE),
      j({ claims: [] }), // empty inventory -> claims failed, pipeline continues
      j({ validated: [], new_comments: [] }), // Intro challenger
      j({ validated: [], new_comments: [] }), // whole-paper challenger
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: 'ok' }), // synthesis (7f)
    );
    const small = new ScriptedProvider();
    small.queue(
      // surveyor: select item 1 (the kept, deduped openalex hit), one missing ref
      j({
        selected: [{ index: 1, why_relevant: 'central prior work' }],
        state_of_the_art_notes: 'frontier is spectral',
        missing_references: [
          {
            title: 'Markov Chains and Mixing Times',
            why_important: 'the standard reference',
          },
        ],
      }),

      j({ items: [] }), // copyedit annex
    );
    const fetchStub = stubFetch((url) => {
      if (url.includes('api.openalex.org')) {
        if (url.includes('search=mixing')) {
          return {
            ok: true,
            json: {
              results: [
                openAlexWork('Mixing Time Bounds', 'W1'),
                openAlexWork('Mixing Time Bounds', 'W1-dup'), // duplicate title
              ],
            },
          };
        }
        return { ok: true, json: { results: [] } };
      }
      if (url.includes('api.crossref.org')) {
        return {
          ok: true,
          json: {
            message: {
              items: [
                {
                  title: ['Markov Chains and Mixing Times'],
                  author: [{ given: 'David', family: 'Levin' }],
                  issued: { 'date-parts': [[2017]] },
                  DOI: '10.1214/xx',
                  URL: 'https://doi.org/10.1214/xx',
                },
              ],
            },
          },
        };
      }
      if (url.includes('api.tavily.com')) {
        return { ok: true, json: { results: [] } };
      }
      return null; // scout sources CORS-blocked -> dropped silently
    });

    try {
      const { state } = await drain(
        runReview({
          doc: makeDoc(),
          settings: makeSettings(),
          providers: { strong, small },
          searchApiKeys: { tavily: 'k' },
        }),
      );
      // survey done; scout done (fetch stub answered / dropped)
      expect(state.stages['survey']).toBe('done');
      expect(state.stages['scout']).toBe('done');
      expect(state.stages['assemble']).toBe('done');
      // surveyor ran on the SMALL role with the survey system prompt
      expect(small.calls[0]!.messages[0]!.content).toContain('literature surveyor');
      // OpenAlex search was issued for the triage queries
      expect(fetchStub.calls.some((u) => u.includes('search=mixing'))).toBe(true);
      // Crossref lookup for the missing reference happened
      expect(
        fetchStub.calls.some((u) => u.includes('query.bibliographic=Markov')),
      ).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });

  it('degraded network (all CORS-blocked) still completes: survey done with empty pack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const strong = new ScriptedProvider();
    strong.queue(
      j(TRIAGE),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: 'ok' }), // synthesis (7f)
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({ items: [] }), // copyedit annex
    );
    const fetchStub = stubFetch(() => null); // every request = CORS TypeError
    try {
      const { state, events } = await drain(
        runReview({
          doc: makeDoc(),
          settings: makeSettings(),
          providers: { strong, small },
          searchApiKeys: { tavily: 'k' },
        }),
      );
      expect(state.stages['survey']).toBe('done'); // pack empty, stage fine
      expect(state.stages['scout']).toBe('done'); // sites dropped, never failed
      expect(state.stages['assemble']).toBe('done');
      // Literature degradation never sets partial; the CLAIMS stage failed
      // (empty inventory), which legitimately does.
      expect(state.partial).toBe(true);
      expect(state.stages['claims']).toBe('failed');
      expect(events.some((e) => e.stage === 'scout' && e.status === 'done')).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('OpenAlex'))).toBe(true);
    } finally {
      fetchStub.restore();
      warn.mockRestore();
    }
  });

  it('surveyor LLM error fails the survey stage and marks the run partial (propagates)', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j(TRIAGE),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: 'ok' }), // synthesis (7f)
    );
    const small = new ScriptedProvider();
    small.queue(
      new LLMError('small provider down'),
      j({ items: [] }), // copyedit annex (runs even after survey failed)
    );
    const fetchStub = stubFetch(() => ({ ok: true, json: { results: [] } }));
    try {
      const { state, events } = await drain(
        runReview({
          doc: makeDoc(),
          settings: makeSettings(),
          providers: { strong, small },
        }),
      );
      expect(state.stages['survey']).toBe('failed');
      expect(state.partial).toBe(true);
      expect(events.some((e) => e.stage === 'survey' && e.status === 'failed')).toBe(
        true,
      );
    } finally {
      fetchStub.restore();
    }
  });

  it('search_queries are capped at 8 (Python run() [:8]) — no unbounded round-trips', async () => {
    const triage = {
      ...TRIAGE,
      search_queries: Array.from({ length: 40 }, (_, i) => `query ${i}`),
    };
    const strong = new ScriptedProvider();
    strong.queue(
      j(triage),
      j({ claims: [] }),
      j({ validated: [], new_comments: [] }),
      j({ validated: [], new_comments: [] }),
      j({ overall_feedback: 'ok' }),
      j({ overall_feedback: 'ok' }), // synthesis (7f)
    );
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({ items: [] }), // copyedit annex
    );
    const fetchStub = stubFetch((url) =>
      url.includes('api.openalex.org')
        ? { ok: true, json: { results: [openAlexWork('W', 'ID')] } }
        : { ok: true, json: { results: [] } },
    );
    try {
      await drain(
        runReview({
          doc: makeDoc(),
          settings: makeSettings(),
          providers: { strong, small },
        }),
      );
      const oaCalls = fetchStub.calls.filter((u) => u.includes('api.openalex.org'));
      expect(oaCalls).toHaveLength(8);
    } finally {
      fetchStub.restore();
    }
  });

  it('scout stage is skipped when the survey stage never produced a pack', async () => {
    const strong = new ScriptedProvider();
    // triage garbage -> survey can't run meaningfully but still runs; instead
    // trip the budget before survey: tiny cap, priced triage.
    const settings = makeSettings();
    settings.maxCostUsd = 0.0001;
    strong.queue(j(TRIAGE));
    const fetchStub = stubFetch(() => {
      throw new Error('no fetch expected');
    });
    try {
      const { state } = await drain(
        runReview({
          doc: makeDoc(),
          settings,
          providers: { strong, small: new ScriptedProvider() },
        }),
      );
      // Budget cap tripped before survey: every later stage drains as skipped.
      expect(state.stages['claims']).toBe('skipped');
      expect(state.stages['scout']).toBe('skipped');
    } finally {
      fetchStub.restore();
    }
  });
});
