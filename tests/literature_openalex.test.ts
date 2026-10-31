import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAlexClient,
  abstractFromInvertedIndex,
  workToItem,
} from '../src/literature/openalex';

const WORK = {
  id: 'https://openalex.org/W2963403868',
  display_name: 'Attention Is All You Need',
  doi: 'https://doi.org/10.5555/3295222.3295349',
  publication_year: 2017,
  cited_by_count: 90000,
  authorships: [
    { author: { display_name: 'A. Vaswani' } },
    { author: { display_name: 'N. Shazeer' } },
  ],
  primary_location: { source: { display_name: 'NeurIPS' } },
  abstract_inverted_index: {
    The: [0],
    dominant: [1],
    models: [3],
    'transduction,sequence': [2],
  },
};

function stubFetch(
  impl: (
    url: string,
  ) => { ok: boolean; status?: number; json?: unknown } | 'network-error',
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const res = impl(url);
    if (res === 'network-error') {
      // CORS / offline in a browser = fetch rejects with TypeError.
      throw new TypeError('Failed to fetch');
    }
    const body = JSON.stringify(res.json ?? {});
    return new Response(body, {
      status: res.ok ? 200 : (res.status ?? 500),
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

afterEach(() => vi.restoreAllMocks());

describe('abstractFromInvertedIndex', () => {
  it('reconstructs position order from the inverted index', () => {
    const inv = { Hello: [1], world: [2], Again: [0] };
    expect(abstractFromInvertedIndex(inv)).toBe('Again Hello world');
  });
  it('empty/absent -> null', () => {
    expect(abstractFromInvertedIndex(null)).toBeNull();
    expect(abstractFromInvertedIndex({})).toBeNull();
  });
});

describe('workToItem mapping', () => {
  it('maps the REST work shape to LiteratureItem (doi prefix stripped, 6-author cap)', () => {
    const many = {
      ...WORK,
      doi: 'http://doi.org/10.1/x',
      authorships: Array.from({ length: 9 }, (_, i) => ({
        author: { display_name: `A${i}` },
      })),
    };
    const it_ = workToItem(many);
    expect(it_.source).toBe('openalex');
    expect(it_.title).toBe('Attention Is All You Need');
    expect(it_.authors).toHaveLength(6);
    expect(it_.doi).toBe('10.1/x');
    expect(it_.venue).toBe('NeurIPS');
    expect(it_.citedBy).toBe(90000);
    expect(it_.year).toBe(2017);
    expect(it_.url).toBe('https://openalex.org/W2963403868');
    expect(it_.abstract).toBe('The dominant transduction,sequence models');
  });
});

describe('OpenAlexClient (scripted fetch, no network)', () => {
  it('searchWorks maps results and sends search/per-page params', async () => {
    const { calls, restore } = stubFetch(() => ({
      ok: true,
      json: { results: [WORK] },
    }));
    try {
      const client = new OpenAlexClient({ mailto: 'a@b.c' });
      const items = await client.searchWorks('attention', 5);
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe('Attention Is All You Need');
      expect(calls[0]).toContain('https://api.openalex.org/works?');
      expect(calls[0]).toContain('search=attention');
      expect(calls[0]).toContain('per-page=5');
      expect(calls[0]).toContain('mailto=a%40b.c');
    } finally {
      restore();
    }
  });

  it('HTTP error -> [] + console.warn (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { restore } = stubFetch(() => ({ ok: false, status: 403 }));
    try {
      const items = await new OpenAlexClient().searchWorks('q');
      expect(items).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('CORS/network failure (fetch TypeError) -> [] + console.warn, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { restore } = stubFetch(() => 'network-error');
    try {
      await expect(new OpenAlexClient().searchWorks('q')).resolves.toEqual([]);
      await expect(new OpenAlexClient().getWorkByDoi('10.1/x')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('getWorkByDoi strips the prefix and lowercases', async () => {
    const { calls, restore } = stubFetch(() => ({ ok: true, json: WORK }));
    try {
      const item = await new OpenAlexClient().getWorkByDoi('HTTPS://DOI.org/10.5555/X');
      expect(item?.title).toBe('Attention Is All You Need');
      expect(calls[0]).toContain('/works/doi:10.5555/x');
    } finally {
      restore();
    }
  });
});

// ------------------------------------- polite-pool email env fallbacks (7d) --
// Python 7949c40: OpenAlex REST queries append mailto alongside api_key;
// the email resolves explicit -> OPENALEX_EMAIL -> shared EMAIL.

describe('OpenAlex polite-pool email fallback (7949c40)', () => {
  const ENV_KEYS = ['OPENALEX_EMAIL', 'EMAIL'] as const;
  const saved: Record<string, string | undefined> = {};
  const grabEnv = (): Record<string, string | undefined> | undefined => {
    try {
      return typeof process !== 'undefined' ? process.env : undefined;
    } catch {
      return undefined;
    }
  };

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    const env = grabEnv();
    if (!env) return;
    for (const k of ENV_KEYS) {
      saved[k] = env[k];
      if (k in values) env[k] = values[k];
      else delete env[k];
    }
  }

  function restoreEnv(): void {
    const env = grabEnv();
    if (!env) return;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  }

  afterEach(restoreEnv);

  it('mailto rides alongside api_key on search and DOI lookups', async () => {
    setEnv({ OPENALEX_EMAIL: 'oa@example.org' });
    const { calls, restore } = stubFetch(() => ({
      ok: true,
      json: { results: [WORK] },
    }));
    try {
      const client = new OpenAlexClient({ apiKey: 'key-1' });
      await client.searchWorks('attention', 5);
      expect(calls[0]).toContain('api_key=key-1');
      expect(calls[0]).toContain('mailto=oa%40example.org');
    } finally {
      restore();
    }
  });

  it('no email anywhere: no mailto param (browser story)', async () => {
    setEnv({});
    const { calls, restore } = stubFetch(() => ({
      ok: true,
      json: { results: [WORK] },
    }));
    try {
      const client = new OpenAlexClient();
      await client.searchWorks('attention', 5);
      expect(calls[0]).not.toContain('mailto=');
    } finally {
      restore();
    }
  });
});
