/**
 * Peer-review-community scout — port of Python
 * `open_referee/literature/scout.py` (PubPeer / OpenReview / PREreview).
 *
 * BROWSER-CORS EDITION: each site's first search failure (fetch rejecting
 * with TypeError = CORS/network block) drops that site for the rest of the
 * run after ONE console.warn — never throws (owner decision: a dead scout
 * source must never fail the review run).
 */

import { literatureItem, type LiteratureItem } from './types';
import { type SearchRouter } from './search';

export const DEFAULT_SITES: Record<string, string> = {
  pubpeer: 'pubpeer.com',
  openreview: 'openreview.net',
  prereview: 'prereview.org',
};

export interface ScoutOptions {
  /** Site flags (Python PeerReviewSourcesConfig); default all true. */
  pubpeer?: boolean;
  openreview?: boolean;
  prereview?: boolean;
  /** Extra site domains beyond the defaults. */
  extraSites?: string[];
}

function clip(title: string, maxChars = 90): string {
  // Python ' '.join(title.split()): collapse runs AND strip edge whitespace.
  return title
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(' ')
    .slice(0, maxChars);
}

export class PeerReviewScout {
  private readonly opts: ScoutOptions;
  private readonly router: SearchRouter;
  /** Sites dropped for the run after a first CORS/network failure. */
  private readonly dropped = new Set<string>();

  constructor(opts: ScoutOptions | undefined, router: SearchRouter) {
    this.opts = opts ?? {};
    this.router = router;
  }

  private sites(): string[] {
    const flags: [boolean | undefined, string][] = [
      [this.opts.pubpeer ?? true, DEFAULT_SITES['pubpeer']!],
      [this.opts.openreview ?? true, DEFAULT_SITES['openreview']!],
      [this.opts.prereview ?? true, DEFAULT_SITES['prereview']!],
    ];
    const out = flags.filter(([flag]) => flag).map(([, domain]) => domain);
    out.push(...(this.opts.extraSites ?? []));
    return out;
  }

  /** Look for prior community discussion of this exact paper. */
  async scanTitle(title: string): Promise<LiteratureItem[]> {
    return this.scan(title, 5, 'Peer-review community discussion found on');
  }

  /** Lighter scan for a cited work (top-n key references). */
  async scanCitation(title: string): Promise<LiteratureItem[]> {
    return this.scan(title, 3, 'Community discussion of a cited work on');
  }

  private async scan(
    title: string,
    limit: number,
    whyPrefix: string,
  ): Promise<LiteratureItem[]> {
    const out: LiteratureItem[] = [];
    for (const site of this.sites()) {
      if (this.dropped.has(site)) continue;
      let hits;
      try {
        // searchStrict rethrows transport faults (TypeError = CORS/network)
        // after the other engines tried; a clean [] (no community posts)
        // does NOT drop the site.
        hits = await this.router.searchStrict(`site:${site} "${clip(title)}"`, limit);
      } catch (err) {
        // Transport fault on every enabled engine — treat as a CORS block
        // and drop the site for the rest of the run (one warn).
        console.warn(
          `scout: search engine unreachable for ${site} (${err instanceof Error ? err.message : String(err)}); dropping for this run`,
        );
        this.dropped.add(site);
        continue;
      }
      const domainKey = site.split('/')[0]!;
      for (const h of hits) {
        if (!h.url.includes(domainKey)) continue;
        out.push({
          ...literatureItem('review_community', h.title || `Discussion on ${site}`),
          url: h.url,
          abstract: h.snippet || null,
          whyRelevant: `${whyPrefix} ${site}`,
        });
      }
    }
    return out;
  }
}
