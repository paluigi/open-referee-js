/**
 * OpenAlex REST client — raw-REST port of Python
 * `open_referee/literature/openalex_client.py` (the openalex-py path has no
 * browser equivalent; the TS port is REST-only, which is what the Python
 * falls back to anyway).
 *
 * Polite pool (7949c40): Python resolves the contact email from
 * OpenAlexConfig.email_env (OPENALEX_EMAIL) falling back to the shared EMAIL
 * variable, and appends `mailto` alongside api_key on every REST query. The
 * TS client resolves `mailto` from the explicit option, then the same env
 * ladder (OPENALEX_EMAIL -> EMAIL) where `process.env` exists — in the
 * browser there is no env, so the polite-pool field is simply absent unless
 * the caller passes `mailto` (documented divergence; the API works without
 * it, just rate-limited harder).
 *
 * All fetches are fail-soft: network/HTTP errors log a console.warn and
 * return `[]` / `null` — never throw (Python best-effort contract; a dead
 * API must never fail a review run).
 */

import { type LiteratureItem } from './types';

const BASE = 'https://api.openalex.org';

export interface OpenAlexOptions {
  /** Polite-pool contact email (query param, browsers-safe). */
  mailto?: string;
  /** Premium API key (query param). */
  apiKey?: string;
}

/**
 * Python `resolved_email()` ladder: explicit value first, then the
 * dedicated env var, then the shared EMAIL variable. Env access is guarded
 * so the browser bundle never touches `process`.
 */
export function resolvePolitePoolEmail(
  explicit: string | undefined,
  dedicatedEnvVar: string,
): string | undefined {
  if (explicit && explicit.trim() !== '') return explicit;
  try {
    const env = typeof process !== 'undefined' && process.env ? process.env : undefined;
    if (!env) return undefined;
    const dedicated = env[dedicatedEnvVar];
    if (dedicated && dedicated.trim() !== '') return dedicated;
    const shared = env['EMAIL'];
    if (shared && shared.trim() !== '') return shared;
  } catch {
    // browsers without process shim: no env story
  }
  return undefined;
}

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  title?: string;
  doi?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: { author?: { display_name?: string } | null }[] | null;
  primary_location?: { source?: { display_name?: string } | null } | null;
}

function params(opts: OpenAlexOptions | undefined): URLSearchParams {
  const p = new URLSearchParams();
  const o = opts ?? {};
  if (o.mailto) p.set('mailto', o.mailto);
  if (o.apiKey) p.set('api_key', o.apiKey);
  return p;
}

/** Python `_rest_abstract`: sort (position, word) pairs, join with spaces. */
export function abstractFromInvertedIndex(
  inv: Record<string, number[]> | null | undefined,
): string | null {
  if (!inv) return null;
  const pos: [number, string][] = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) pos.push([i, word]);
  }
  pos.sort((a, b) => a[0] - b[0]);
  return pos.map(([, word]) => word).join(' ') || null;
}

function stripDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return doi.replace('https://doi.org/', '').replace('http://doi.org/', '') || null;
}

/** Python `_rest_work_to_item`. */
export function workToItem(w: OpenAlexWork): LiteratureItem {
  const authorships = w.authorships ?? [];
  return {
    source: 'openalex',
    title: w.display_name ?? w.title ?? '',
    authors: authorships.slice(0, 6).map((a) => a.author?.display_name ?? ''),
    year: w.publication_year ?? null,
    doi: stripDoi(w.doi),
    venue: w.primary_location?.source?.display_name ?? null,
    citedBy: w.cited_by_count ?? null,
    abstract: abstractFromInvertedIndex(w.abstract_inverted_index),
    url: w.id ?? null,
    whyRelevant: null,
  };
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    console.warn(
      `OpenAlex request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export class OpenAlexClient {
  private readonly opts: OpenAlexOptions | undefined;

  constructor(opts?: OpenAlexOptions) {
    this.opts = opts;
  }

  /** Resolved polite-pool email: explicit option, then OPENALEX_EMAIL/EMAIL env. */
  private get email(): string | undefined {
    return resolvePolitePoolEmail(this.opts?.mailto, 'OPENALEX_EMAIL');
  }

  /** Search works; `[]` on any failure. */
  async searchWorks(query: string, limit = 10): Promise<LiteratureItem[]> {
    const p = params(this.opts);
    const email = this.email;
    if (email) p.set('mailto', email);
    p.set('search', query);
    p.set('per-page', String(limit));
    const json = await getJson(`${BASE}/works?${p.toString()}`);
    if (!json) return [];
    const results = (json as { results?: OpenAlexWork[] })['results'];
    if (!Array.isArray(results)) return [];
    return results.map(workToItem);
  }

  /** DOI lookup (`https://doi.org/` prefixes stripped); `null` on failure. */
  async getWorkByDoi(doi: string): Promise<LiteratureItem | null> {
    const clean = doi.toLowerCase().replace('https://doi.org/', '');
    const p = params(this.opts);
    const email = this.email;
    if (email) p.set('mailto', email);
    const json = await getJson(`${BASE}/works/doi:${clean}?${p.toString()}`);
    if (!json) return null;
    return workToItem(json as OpenAlexWork);
  }
}
