import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchRouter } from '../src/literature/search';

interface ScriptedResponse {
  ok: boolean;
  status?: number;
  json?: unknown;
}

/** Stub globalThis.fetch; `null` response = CORS TypeError rejection. */
function stubFetch(
  impl: (url: string, init: RequestInit | undefined) => ScriptedResponse | null,
): { calls: { url: string; init?: RequestInit }[]; restore: () => void } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const res = impl(url, init);
    if (!res) throw new TypeError('Failed to fetch'); // CORS / network
    return new Response(JSON.stringify(res.json ?? {}), {
      status: res.ok ? 200 : (res.status ?? 500),
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const TAVILY = {
  results: [{ title: 'T1', url: 'https://t1', content: 'tavily snippet' }],
};
const TINYFISH = {
  results: [{ title: 'F1', url: 'https://f1', snippet: 'tinyfish snippet' }],
};

afterEach(() => vi.restoreAllMocks());

describe('SearchRouter failover', () => {
  it('first engine non-empty wins (tavily before tinyfish)', async () => {
    const { calls, restore } = stubFetch((url) =>
      url.includes('tavily')
        ? { ok: true, json: TAVILY }
        : { ok: true, json: TINYFISH },
    );
    try {
      const hits = await new SearchRouter({
        keys: { tavily: 'tv', tinyfish: 'tf' },
      }).search('q');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.engine).toBe('tavily');
      expect(hits[0]!.snippet).toBe('tavily snippet');
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('first engine empty -> falls through to the second', async () => {
    const { calls, restore } = stubFetch((url) =>
      url.includes('tavily')
        ? { ok: true, json: { results: [] } }
        : { ok: true, json: TINYFISH },
    );
    try {
      const hits = await new SearchRouter({
        keys: { tavily: 'tv', tinyfish: 'tf' },
      }).search('q');
      expect(hits[0]!.engine).toBe('tinyfish');
      expect(calls).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('first engine CORS TypeError -> warns and falls through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { restore } = stubFetch((url) =>
      url.includes('tavily') ? null : { ok: true, json: TINYFISH },
    );
    try {
      const hits = await new SearchRouter({
        keys: { tavily: 'tv', tinyfish: 'tf' },
      }).search('q');
      expect(hits[0]!.engine).toBe('tinyfish');
      expect(warn).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('searchStrict rethrows transport TypeError after the other engines tried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, restore } = stubFetch(() => null); // every engine CORS-blocked
    try {
      const router = new SearchRouter({ keys: { tavily: 'tv', tinyfish: 'tf' } });
      await expect(router.searchStrict('q', 5)).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(2); // both engines still got their chance
      expect(warn).toHaveBeenCalledTimes(2); // one warn per engine
    } finally {
      restore();
    }
  });

  it('searchStrict returns [] on a clean empty result (no transport fault)', async () => {
    const { restore } = stubFetch(() => ({ ok: true, json: { results: [] } }));
    try {
      const router = new SearchRouter({ keys: { tavily: 'tv', tinyfish: 'tf' } });
      await expect(router.searchStrict('q', 5)).resolves.toEqual([]);
    } finally {
      restore();
    }
  });

  it('searchStrict lets a later engine satisfy the query despite an earlier TypeError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { restore } = stubFetch((url) =>
      url.includes('tavily') ? null : { ok: true, json: TINYFISH },
    );
    try {
      const hits = await new SearchRouter({
        keys: { tavily: 'tv', tinyfish: 'tf' },
      }).searchStrict('q');
      expect(hits[0]!.engine).toBe('tinyfish');
      expect(warn).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('unkeyed engines are skipped; all-fail -> []', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noKeys = stubFetch(() => {
      throw new Error('should not be called');
    });
    try {
      await expect(new SearchRouter({}).search('q')).resolves.toEqual([]);
      expect(noKeys.calls).toHaveLength(0);
    } finally {
      noKeys.restore();
    }
    const allFail = stubFetch(() => null);
    try {
      await expect(
        new SearchRouter({ keys: { tavily: 'tv' } }).search('q'),
      ).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      allFail.restore();
    }
  });

  it('searchAll merges hits from every engine and survives failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { restore } = stubFetch((url) =>
      url.includes('tavily') ? null : { ok: true, json: TINYFISH },
    );
    try {
      const hits = await new SearchRouter({
        keys: { tavily: 'tv', tinyfish: 'tf' },
      }).searchAll('q');
      expect(hits.map((h) => h.engine)).toEqual(['tinyfish']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('tavily POST body carries api_key/query/max_results; tinyfish uses X-API-Key', async () => {
    const { calls, restore } = stubFetch((url) =>
      url.includes('tavily')
        ? { ok: true, json: TAVILY }
        : { ok: true, json: TINYFISH },
    );
    try {
      const router = new SearchRouter({ keys: { tavily: 'K1', tinyfish: 'K2' } });
      await router.searchAll('my query', 3);
      const post = calls.find((c) => c.url.includes('tavily'))!;
      expect(post.init?.method).toBe('POST');
      expect(String(post.init?.body)).toContain('"api_key":"K1"');
      expect(String(post.init?.body)).toContain('"max_results":3');
      const get = calls.find((c) => c.url.includes('tinyfish'))!;
      expect(get.url).toContain('query=my+query');
      expect(get.url).toContain('num_results=3');
      expect((get.init?.headers as Record<string, string>)['X-API-Key']).toBe('K2');
    } finally {
      restore();
    }
  });

  it('enabledEngines filters settings.searchOrder to supported engines (no Brave)', () => {
    expect(
      new SearchRouter({
        order: ['tavily', 'brave', 'tinyfish', 'nonsense'],
      }).enabledEngines(),
    ).toEqual(['tavily', 'tinyfish']);
  });
});
