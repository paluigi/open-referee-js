/**
 * Deterministic per-reference resolution against Crossref + OpenAlex.
 *
 * Port of Python `open_referee/literature/reference_resolution.py`:
 * for every bibliography entry, build a query from the entry text, look it up
 * in Crossref and OpenAlex, and score the candidates against the entry's
 * probable title. Entries with no acceptable match become "unmatched" —
 * phantom-candidate findings the bibliography auditor and the validator can
 * use as ground truth. Free of LLM cost; time-boxed.
 *
 * Clients are injected (`resolveReferences(referencesText, clients, opts?)`),
 * so unit tests stub them and never touch fetch; the browser callers wire
 * the real CrossrefClient/OpenAlexClient (live network, CORS-verified).
 */

import { mapPool } from '../pipeline/pool';
import type { LiteratureItem } from './types';
import { similarityRatio } from '../util/sequence_matcher';

export const MAX_REFS = 60;
export const CONCURRENCY = 4;
export const OVERALL_TIMEOUT_S = 60;
export const MATCH_THRESHOLD = 0.72;

const YEAR_RE = /\b(19|20)\d{2}\b/;
const LEADING_MARKER_RE = /^\s*(?:\[\d+\]|\d{1,3}[.)])\s*/;
const START_RE = /^(?:\[\d+\]|\d{1,3}[.)]\s|[-•]\s|\*\s?)/;

/** One resolved (or unmatched) reference record (Python resolve_references). */
export interface ResolutionRecord {
  ref: string;
  status: 'matched' | 'unmatched';
  score: number;
  doi?: string | null;
  title?: string | null;
  venue?: string | null;
  year?: number | null;
  source?: string | null;
  error?: string;
}

/** Client surface injected by the caller (test stubs implement this). */
export interface ResolutionClients {
  crossref: { lookup(query: string): Promise<LiteratureItem | null> };
  openalex: { searchWorks(query: string, limit?: number): Promise<LiteratureItem[]> };
}

/**
 * Split a raw bibliography blob into entries.
 *
 * Handles numbered ([1] / 1.), bulleted (-) and blank-line separated lists.
 * Char-parity port of Python `split_references`.
 */
export function splitReferences(referencesText: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of referencesText.split(/\r\n|\n|\r/)) {
    const s = line.trim();
    if (!s) {
      if (current.length > 0) {
        entries.push(current.join(' '));
        current = [];
      }
      continue;
    }
    if (START_RE.test(s) && current.length > 0) {
      entries.push(current.join(' '));
      current = [s];
    } else if (current.length > 0 || START_RE.test(s)) {
      current.push(s);
    } else if (s.length > 40) {
      current = [s];
    }
  }
  if (current.length > 0) entries.push(current.join(' '));
  return entries.map((e) => e.replace(/\s+/g, ' ').trim()).filter((e) => e.length > 15);
}

/** Best-effort title substring of a raw reference entry (Python _title_guess). */
export function titleGuess(entry: string): string {
  // drop the leading marker, then take the longest dot-separated chunk
  // that is not a person-name list (no year, >= 4 words, has lowercase).
  let body = entry.replace(LEADING_MARKER_RE, '');
  const yearMatch = YEAR_RE.exec(body);
  if (yearMatch && yearMatch.index !== undefined) {
    body =
      body.slice(0, yearMatch.index) +
      ' ' +
      body.slice(yearMatch.index + yearMatch[0].length);
  }
  const chunks = body.split(/(?:\.|,)\s+/);
  let best = '';
  for (const c of chunks) {
    const words = c.split(/\s+/).filter((w) => w.length > 0);
    const hasLower = words.some((w) => w !== w.toUpperCase() && w === w.toLowerCase());
    if (words.length >= 4 && hasLower && c.length > best.length) best = c;
  }
  return best || body;
}

/** Python `_norm`: lowercase, non-[a-z0-9 ] runs -> single spaces, trimmed. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();
}

/**
 * Faithful `round(x, 2)` for a finite double (CPython `_Py_dg_dtoa`
 * semantics): correctly-rounded decimal conversion of the BINARY value,
 * with half-to-even applying only when the value is an exact decimal
 * half (m/200 for odd m — e.g. 0.125 -> 0.12, but 0.715's double is
 * slightly below the half so it rounds DOWN to 0.71). Scaling by 100
 * first double-rounds (0.715 * 100 = 71.5 exactly), so the half test
 * runs on the exact binary expansion via BigInt, and everything else
 * goes through toFixed(2) (spec: correctly-rounded decimal string).
 * Parity: 500-seeded-fuzz + 20 edge cases vs `uv run python` round().
 */
export function roundPy2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = x;
  const bits = BigInt.asUintN(64, new BigUint64Array(buf)[0]!);
  const sign = bits >> 63n ? -1n : 1n;
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  let num: bigint;
  let exp: bigint;
  if (rawExp === 0) {
    num = frac;
    exp = -1074n;
  } else {
    num = frac | (1n << 52n);
    exp = BigInt(rawExp - 1075);
  }
  const signed = sign * num;
  const scaled = signed * 200n;
  let m: bigint | null = null;
  if (exp >= 0n) {
    m = scaled << exp;
  } else {
    const d = 1n << -exp;
    if (scaled % d === 0n) m = scaled / d;
  }
  if (m !== null && m % 2n === 1n) {
    const down = (m - 1n) / 2n;
    const up = (m + 1n) / 2n;
    return Number(down % 2n === 0n ? down : up) / 100;
  }
  return Number(x.toFixed(2));
}

/** Python `_score(entry, title_guess, item)`: max(ratio, whole*0.9). */
export function score(entry: string, guess: string, item: LiteratureItem): number {
  if (!item.title) return 0.0;
  const a = norm(guess);
  const b = norm(item.title);
  const ratio = similarityRatio(a, b);
  // whole-entry overlap helps when the title guess failed (authory chunks)
  const whole = similarityRatio(norm(entry).slice(0, 220), b);
  return Math.max(ratio, whole * 0.9);
}

/** Python `_query_for`: marker-stripped body, truncated to 220 chars. */
export function queryFor(entry: string): string {
  return entry.replace(LEADING_MARKER_RE, '').slice(0, 220);
}

/**
 * Python `resolve_references`: bounded-concurrency, overall-time-boxed,
 * per-call fail-soft resolution. Timeout -> every entry unmatched with
 * error 'timeout'; per-entry failures -> unmatched with the error text.
 */
export async function resolveReferences(
  referencesText: string,
  clients: ResolutionClients,
  opts?: { maxRefs?: number; timeoutS?: number },
): Promise<ResolutionRecord[]> {
  const maxRefs = opts?.maxRefs ?? MAX_REFS;
  const timeoutS = opts?.timeoutS ?? OVERALL_TIMEOUT_S;
  const entries = splitReferences(referencesText).slice(0, maxRefs);
  if (entries.length === 0) return [];

  const resolveOne = async (entry: string): Promise<ResolutionRecord> => {
    const query = queryFor(entry);
    const candidates: LiteratureItem[] = [];
    // Per-call fail-soft: a dead client is not a failed resolution.
    try {
      const hit = await clients.crossref.lookup(query);
      if (hit !== null) candidates.push(hit);
    } catch {
      /* resolution is best-effort */
    }
    try {
      candidates.push(...(await clients.openalex.searchWorks(query, 3)));
    } catch {
      /* resolution is best-effort */
    }
    const guess = titleGuess(entry);
    let best: LiteratureItem | null = null;
    let bestScore = 0.0;
    for (const item of candidates) {
      const s = score(entry, guess, item);
      if (s > bestScore) {
        best = item;
        bestScore = s;
      }
    }
    const rec: ResolutionRecord = {
      ref: entry.slice(0, 240),
      status: 'unmatched',
      score: roundPy2(bestScore),
    };
    if (best !== null && bestScore >= MATCH_THRESHOLD) {
      const matched = best as LiteratureItem;
      rec.status = 'matched';
      rec.doi = matched.doi ?? null;
      rec.title = matched.title ?? null;
      rec.venue = matched.venue ?? null;
      rec.year = matched.year ?? null;
      rec.source = matched.source;
    }
    return rec;
  };

  const guarded = async (entry: string): Promise<ResolutionRecord> => {
    try {
      return await resolveOne(entry);
    } catch (err) {
      return {
        ref: entry.slice(0, 240),
        status: 'unmatched',
        score: 0.0,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      };
    }
  };

  // Overall time box: on timeout, every entry is returned unmatched with
  // error 'timeout' (Python asyncio.wait_for + TimeoutError branch).
  const pooled = mapPool(entries, CONCURRENCY, guarded);
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<'timeout'>((resolve) => {
    timerId = setTimeout(() => resolve('timeout'), timeoutS * 1000);
  });
  let settled: 'timeout' | 'done' = 'timeout';
  let results: (ResolutionRecord | undefined)[] = [];
  try {
    const outcome = await Promise.race([
      pooled.then((r): 'done' => {
        results = r.map((x) => (x.ok ? x.value : undefined));
        return 'done';
      }),
      timer,
    ]);
    settled = outcome;
    clearTimeout(timerId);
  } catch {
    // mapPool never rejects (per-slot error capture); defensive only.
    settled = 'done';
  }
  if (settled === 'timeout') {
    return entries.map((e): ResolutionRecord => ({
      ref: e.slice(0, 240),
      status: 'unmatched',
      score: 0.0,
      error: 'timeout',
    }));
  }
  return entries.map((e, i) => {
    const r = results[i];
    return (
      r ?? {
        ref: e.slice(0, 240),
        status: 'unmatched' as const,
        score: 0.0,
        error: 'resolution failed',
      }
    );
  });
}

/** Python str(float): integral floats keep a '.0' suffix ('0.0', '1.0'). */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/**
 * Python `_render_resolutions` (orchestrator.py): the block fed into the
 * bibliography prompt. Empty records -> '(resolution unavailable)'.
 */
export function renderResolutions(records: ResolutionRecord[]): string {
  if (records.length === 0) return '(resolution unavailable)';
  const lines: string[] = [];
  for (const r of records) {
    if (r.status === 'matched') {
      const doi = r.doi || 'no-doi';
      // Python `str(r.get('title'))` renders null as 'None'; `or`-defaults treat 0/'' as missing.
      const title = String(r.title ?? 'None').slice(0, 110);
      const venue = r.venue || '?';
      const year = r.year || '?';
      lines.push(
        `- MATCHED ${doi} :: ${title} (${venue}, ${year}) [score ${pyFloat(r.score)}]`,
      );
    } else {
      const ref = String(r.ref ?? 'None').slice(0, 110);
      lines.push(`- UNMATCHED :: ${ref} [best score ${pyFloat(r.score)}]`);
    }
  }
  return lines.join('\n').slice(0, 20_000);
}
