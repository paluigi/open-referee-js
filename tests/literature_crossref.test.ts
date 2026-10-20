import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CrossrefClient,
  crossrefItemToLiteratureItem,
} from '../src/literature/crossref';

const ITEM = {
  title: ['Deep Residual Learning for Image Recognition'],
  author: [
    { given: 'Kaiming', family: 'He' },
    { given: 'Xiangyu', family: 'Zhang' },
  ],
  issued: { 'date-parts': [[2016]] },
  DOI: '10.1109/CVPR.2016.90',
  'container-title': ['CVPR'],
  URL: 'https://doi.org/10.1109/CVPR.2016.90',
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
    if (res === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(res.json ?? {}), {
      status: res.ok ? 200 : (res.status ?? 500),
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

afterEach(() => vi.restoreAllMocks());

describe('crossrefItemToLiteratureItem', () => {
  it('maps title[0], given+family authors, date-parts year, DOI, venue, URL', () => {
    const lit = crossrefItemToLiteratureItem(ITEM);
    expect(lit.source).toBe('crossref');
    expect(lit.title).toBe('Deep Residual Learning for Image Recognition');
    expect(lit.authors).toEqual(['Kaiming He', 'Xiangyu Zhang']);
    expect(lit.year).toBe(2016);
    expect(lit.doi).toBe('10.1109/CVPR.2016.90');
    expect(lit.venue).toBe('CVPR');
    expect(lit.url).toBe('https://doi.org/10.1109/CVPR.2016.90');
  });

  it('caps authors at 6 and tolerates missing fields', () => {
    const many = {
      ...ITEM,
      author: Array.from({ length: 9 }, (_, i) => ({
        given: `G${i}`,
        family: `F${i}`,
      })),
      title: null,
      issued: null,
    };
    const lit = crossrefItemToLiteratureItem(many);
    expect(lit.authors).toHaveLength(6);
    expect(lit.title).toBe('');
    expect(lit.year).toBeNull();
  });
});

describe('CrossrefClient (scripted fetch, no network)', () => {
  it('lookup sends query.bibliographic + rows=1 + mailto polite param', async () => {
    const { calls, restore } = stubFetch(() => ({
      ok: true,
      json: { message: { items: [ITEM] } },
    }));
    try {
      const item = await new CrossrefClient({ mailto: 'ref@example.org' }).lookup(
        'residual',
      );
      expect(item?.title).toBe('Deep Residual Learning for Image Recognition');
      expect(calls[0]).toContain('https://api.crossref.org/works?');
      expect(calls[0]).toContain('query.bibliographic=residual');
      expect(calls[0]).toContain('rows=1');
      expect(calls[0]).toContain('mailto=ref%40example.org');
      // DIVERGENCE: browsers forbid User-Agent, so no header is set and the
      // polite pool is joined via the mailto query param (checked above).
    } finally {
      restore();
    }
  });

  it('empty items -> null without warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { restore } = stubFetch(() => ({
      ok: true,
      json: { message: { items: [] } },
    }));
    try {
      await expect(new CrossrefClient().lookup('x')).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('HTTP error and CORS TypeError -> null + console.warn (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = stubFetch(() => ({ ok: false, status: 429 }));
    try {
      await expect(new CrossrefClient().lookup('x')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      bad.restore();
    }
    const cors = stubFetch(() => 'network-error');
    try {
      await expect(new CrossrefClient().lookup('x')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      cors.restore();
    }
  });
});
