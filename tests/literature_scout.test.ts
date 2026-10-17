import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeerReviewScout } from '../src/literature/scout';
import { type SearchHit, type SearchRouter } from '../src/literature/search';

function hit(url: string, title = 'T'): SearchHit {
  return { title, url, snippet: 'snip', engine: 'test' };
}

/** Router stub whose failures are CORS-style TypeErrors (per-site). */
function routerStub(behavior: (query: string) => SearchHit[]): {
  router: SearchRouter;
  queries: string[];
} {
  const queries: string[] = [];
  const router = {
    // The scout calls searchStrict; clean [] results resolve, throws surface.
    searchStrict: async (query: string, _limit?: number) => {
      queries.push(query);
      return behavior(query);
    },
  } as unknown as SearchRouter;
  return { router, queries };
}

afterEach(() => vi.restoreAllMocks());

describe('PeerReviewScout', () => {
  it('scanTitle queries every default site with site-scoped clipped queries and filters by domain', async () => {
    const { router, queries } = routerStub((q) => {
      if (q.includes('pubpeer.com')) {
        return [
          hit('https://pubpeer.com/publications/ABC'),
          hit('https://elsewhere.com/x'),
        ];
      }
      return [];
    });
    const scout = new PeerReviewScout(undefined, router);
    const found = await scout.scanTitle('  A   Spaced   Out Title  ');
    expect(queries).toHaveLength(3);
    expect(queries[0]).toBe('site:pubpeer.com "A Spaced Out Title"');
    expect(queries[1]).toBe('site:openreview.net "A Spaced Out Title"');
    expect(queries[2]).toBe('site:prereview.org "A Spaced Out Title"');
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe('review_community');
    expect(found[0]!.url).toBe('https://pubpeer.com/publications/ABC');
    expect(found[0]!.whyRelevant).toBe(
      'Peer-review community discussion found on pubpeer.com',
    );
  });

  it('scanCitation uses limit 3 and the citation why-line', async () => {
    const { router, queries } = routerStub(() => [
      hit('https://openreview.net/forum?id=x'),
    ]);
    const scout = new PeerReviewScout(undefined, router);
    const found = await scout.scanCitation('Some Cited Work');
    expect(queries[0]).toBe('site:pubpeer.com "Some Cited Work"');
    expect(found[0]!.whyRelevant).toBe(
      'Community discussion of a cited work on openreview.net',
    );
  });

  it('CORS drop after first failure: site skipped for the rest of the run, one warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let pubpeerCalls = 0;
    const { router } = routerStub((q) => {
      if (q.includes('pubpeer.com')) {
        pubpeerCalls += 1;
        throw new TypeError('Failed to fetch'); // CORS block
      }
      return [];
    });
    const scout = new PeerReviewScout(undefined, router);
    await expect(scout.scanTitle('P1')).resolves.toEqual([]);
    await expect(scout.scanTitle('P2')).resolves.toEqual([]);
    await expect(scout.scanCitation('P3')).resolves.toEqual([]);
    // pubpeer was tried once, then dropped for the run; other sites continue.
    expect(pubpeerCalls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('pubpeer.com');
  });

  it('site flags off / extraSites are honored', async () => {
    const { router, queries } = routerStub(() => []);
    const scout = new PeerReviewScout(
      { pubpeer: false, extraSites: ['scielo.org'] },
      router,
    );
    await scout.scanTitle('X');
    expect(queries).toEqual([
      'site:openreview.net "X"',
      'site:prereview.org "X"',
      'site:scielo.org "X"',
    ]);
  });

  it('title clipping at 90 chars with whitespace collapse', async () => {
    const { router, queries } = routerStub(() => []);
    const scout = new PeerReviewScout(undefined, router);
    const long = `  ${'word '.repeat(40)}end  `;
    await scout.scanTitle(long);
    const inner = queries[0]!.split('"')[1]!;
    expect(inner.length).toBeLessThanOrEqual(90);
    expect(inner.startsWith('word word')).toBe(true);
    expect(inner).not.toContain('  ');
  });

  it('empty hit title falls back to "Discussion on <site>"', async () => {
    const { router } = routerStub(() => [hit('https://pubpeer.com/p/1', '')]);
    const scout = new PeerReviewScout(undefined, router);
    const found = await scout.scanTitle('P');
    expect(found[0]!.title).toBe('Discussion on pubpeer.com');
  });
});
