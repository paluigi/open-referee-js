/**
 * Crossref client — port of Python `open_referee/literature/crossref.py`.
 *
 * DIVERGENCE (documented, plan-mandated): Python joins the Crossref polite
 * pool via the `User-Agent: open-referee/0.1 (mailto:...)` header. Browsers
 * forbid setting User-Agent on fetch, so the TS port uses the `mailto` query
 * parameter instead — Crossref officially supports it for polite-pool access.
 *
 * Polite pool (7949c40): Python resolves the email from
 * CrossrefConfig.resolved_email() — explicit config, then CROSSREF_EMAIL,
 * then the shared EMAIL env var. The TS client mirrors that ladder via
 * `resolvePolitePoolEmail` where an env exists (Node/tests); in the browser
 * the field is absent unless the caller passes `mailto`.
 *
 * Fail-soft like every literature client: any failure -> null + console.warn.
 */

import { type LiteratureItem } from './types';
import { resolvePolitePoolEmail } from './openalex';

const URL_BASE = 'https://api.crossref.org/works';

export interface CrossrefOptions {
  /** Polite-pool contact email (sent as the `mailto` query param). */
  mailto?: string;
}

interface CrossrefItem {
  title?: string[] | null;
  author?: { given?: string; family?: string }[] | null;
  issued?: { 'date-parts'?: number[][] | null } | null;
  DOI?: string | null;
  'container-title'?: (string | null)[] | null;
  URL?: string | null;
}

export function crossrefItemToLiteratureItem(item: CrossrefItem): LiteratureItem {
  const authors = (item.author ?? [])
    .slice(0, 6)
    .map((a) => `${a.given ?? ''} ${a.family ?? ''}`.trim());
  return {
    source: 'crossref',
    title: (item.title ?? [''])[0] ?? '',
    authors,
    year: (item.issued?.['date-parts'] ?? [[null]])[0]?.[0] ?? null,
    doi: item.DOI ?? null,
    venue: (item['container-title'] ?? [null])[0] ?? null,
    citedBy: null,
    abstract: null,
    url: item.URL ?? null,
    whyRelevant: null,
  };
}

export class CrossrefClient {
  private readonly explicitMailto: string | undefined;

  constructor(opts?: CrossrefOptions) {
    this.explicitMailto = opts?.mailto;
  }

  /** Resolved polite-pool email: explicit option, then CROSSREF_EMAIL/EMAIL env. */
  private get mailto(): string | undefined {
    return resolvePolitePoolEmail(this.explicitMailto, 'CROSSREF_EMAIL');
  }

  /** Title lookup (rows=1); `null` on any failure. */
  async lookup(title: string): Promise<LiteratureItem | null> {
    try {
      const p = new URLSearchParams({
        'query.bibliographic': title,
        rows: '1',
      });
      const email = this.mailto;
      if (email) p.set('mailto', email);
      const r = await fetch(`${URL_BASE}?${p.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as { message?: { items?: CrossrefItem[] } };
      const items = json.message?.items ?? [];
      const first = items[0];
      if (!first) return null;
      return crossrefItemToLiteratureItem(first);
    } catch (err) {
      console.warn(
        `Crossref lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
