/**
 * Web search router — port of Python `open_referee/literature/search.py`,
 * narrowed to the browser-CORS-verified engines: Tavily and TinyFish.
 * **No Brave** — api.search.brave.com sends no CORS headers (owner decision).
 *
 * Engine priority comes from `settings.searchOrder` (default
 * ['tavily', 'tinyfish']); failover is top-down until an engine returns a
 * non-empty result set. API keys come from the session key map (same
 * treatment as provider keys pre-vault).
 *
 * Fail-soft: an engine error logs a console.warn and the router moves on;
 * `search` never rejects.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export type SearchEngineName = 'tavily' | 'tinyfish';

export interface SearchApiKeys {
  tavily?: string;
  tinyfish?: string;
}

export interface SearchRouterOptions {
  /** Engine priority order; unknown names are ignored. */
  order?: string[];
  keys?: SearchApiKeys;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[] | null;
}
interface TinyfishResponse {
  results?: { title?: string; url?: string; snippet?: string }[] | null;
}

export class SearchRouter {
  private readonly order: string[];
  private readonly keys: SearchApiKeys;

  constructor(opts?: SearchRouterOptions) {
    this.order = opts?.order ?? ['tavily', 'tinyfish'];
    this.keys = opts?.keys ?? {};
  }

  /** Engines from `order` that we support. */
  enabledEngines(): SearchEngineName[] {
    return this.order.filter(
      (e): e is SearchEngineName => e === 'tavily' || e === 'tinyfish',
    );
  }

  /**
   * Run through the engine priority list with failover; first non-empty
   * result set wins. `[]` when every engine fails or is unkeyed.
   */
  async search(query: string, limit = 8): Promise<SearchHit[]> {
    for (const engine of this.enabledEngines()) {
      try {
        const hits = await this.searchEngine(engine, query, limit);
        if (hits.length > 0) return hits;
      } catch (err) {
        console.warn(
          `search engine ${engine} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return [];
  }

  /**
   * Like `search`, but rethrows the first TRANSPORT failure (fetch rejecting
   * with TypeError = CORS/network block) after the remaining engines had
   * their chance. An empty-but-clean result set still returns `[]` — only a
   * genuine transport fault surfaces. The scout uses this so a browser-
   * blocked engine can trigger its per-site drop contract.
   */
  async searchStrict(query: string, limit = 8): Promise<SearchHit[]> {
    let transportError: TypeError | undefined;
    for (const engine of this.enabledEngines()) {
      try {
        const hits = await this.searchEngine(engine, query, limit);
        if (hits.length > 0) return hits;
      } catch (err) {
        if (err instanceof TypeError) transportError = transportError ?? err;
        console.warn(
          `search engine ${engine} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (transportError) throw transportError;
    return [];
  }

  /** Query every enabled engine (used for the review-community scout). */
  async searchAll(query: string, limit = 5): Promise<SearchHit[]> {
    const out: SearchHit[] = [];
    for (const engine of this.enabledEngines()) {
      try {
        out.push(...(await this.searchEngine(engine, query, limit)));
      } catch (err) {
        console.warn(
          `search engine ${engine} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  private async searchEngine(
    engine: SearchEngineName,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const key = this.keys[engine];
    if (!key) return [];
    if (engine === 'tavily') return this.tavily(query, limit, key);
    return this.tinyfish(query, limit, key);
  }

  private async tavily(
    query: string,
    limit: number,
    key: string,
  ): Promise<SearchHit[]> {
    const json = (await postJson(
      'https://api.tavily.com/search',
      { api_key: key, query, max_results: limit },
      {},
    )) as TavilyResponse;
    return (json.results ?? []).map((h) => ({
      title: h.title ?? '',
      url: h.url ?? '',
      snippet: h.content ?? '',
      engine: 'tavily',
    }));
  }

  private async tinyfish(
    query: string,
    limit: number,
    key: string,
  ): Promise<SearchHit[]> {
    const p = new URLSearchParams({ query, num_results: String(limit) });
    const json = (await getJson(
      `https://api.search.tinyfish.ai/search?${p.toString()}`,
      { 'X-API-Key': key },
    )) as TinyfishResponse;
    return (json.results ?? []).map((h) => ({
      title: h.title ?? '',
      url: h.url ?? '',
      snippet: h.snippet ?? '',
      engine: 'tinyfish',
    }));
  }
}
