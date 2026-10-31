/**
 * Bibliography audit stage (Stage 6).
 *
 * Port of Python orchestrator `_bibliography` + `_extract_intext_citations`.
 * The citation extractor is a char-parity port: the emitted
 * `- cite :: claim` string must match Python byte-for-byte on identical
 * input (harnessed in tests/bibliography.test.ts against `uv run python`
 * repr constants). The audit is fail-soft where Python is not: Python's
 * `complete_json` re-raises JSONDecodeError after the repair retry and
 * `_bibliography` catches only LLMError, so unparseable JSON kills the
 * Python run — here an LLM/parse failure yields the empty audit instead
 * (deliberate divergence: a citation audit must never fail a review).
 * Only a tripped budget cap is surfaced to the caller.
 */

import type { Document } from '../ingestion/document';
import type { ContextPack } from '../literature/types';
import { renderPack } from '../literature/types';
import { BudgetExceeded } from '../providers/usage';
import { callJsonWithRepair, type CallJson } from './claims';
import { bibliographyPrompt, bibliographySystem } from './prompts';

/** One audited bibliography entry (shape is LLM-produced, keys snake_case). */
export type BibAuditRecord = Record<string, unknown>;

/** Python `_bibliography` result contract. */
export interface BibliographyAudit {
  entries: BibAuditRecord[];
  in_text_issues: BibAuditRecord[];
  missing_key_references: BibAuditRecord[];
}

/** The fail-soft empty audit (Python `empty` dict in `_bibliography`). */
export function emptyAudit(): BibliographyAudit {
  return { entries: [], in_text_issues: [], missing_key_references: [] };
}

// Python `_extract_intext_citations` patterns, in order. Author-year runs
// FIRST so it claims the full span before the bare-paren pattern can reduce
// "(Smith, 2001)" to "(2001)"-style leftovers.
const CITATION_PATTERNS: RegExp[] = [
  // Author (1999) / Author and Other (1999)
  /([A-Z][A-Za-z'’\u002d]+(?:\s+(?:and|&|et al\.?)\s+[A-Z][A-Za-z'’\u002d]+){0,2}\s*\(\d{4}[a-z]?\))/g,
  // numeric [1] / [1, 2] / [1-3]
  /(\[[0-9][0-9,\s\u002d–]*\])/g,
  // (Author, 1999) / (Author and Other, 1999; Third, 2020)
  /\(([^()]{0,80}?\d{4}[a-z]?[^()]{0,80}?)\)/g,
  // natbib \citep-style leftovers: Smith2001 / Jones2020
  /\b([A-Z][a-z]{2,}\d{2,4})\b/g,
];

/**
 * Extract in-text citation mentions with claim context for the audit.
 *
 * Matches the common author-year styles: (Smith, 2001), Smith (2001),
 * (Smith and Jones, 2001; Doe, 2019), [1], [Smith2001]. For each match,
 * keeps the surrounding sentence as the claim context. Char-parity with
 * Python `_extract_intext_citations`.
 */
export function extractInTextCitations(doc: Document, maxCitations = 60): string {
  const text = doc.fullText();
  const hits: { cite: string; claim: string }[] = [];
  const seenSpans: [number, number][] = [];

  const overlaps = (s: number, e: number): boolean =>
    seenSpans.some(([bs, be]) => s < be && e > bs);

  outer: for (const pat of CITATION_PATTERNS) {
    for (const m of text.matchAll(pat)) {
      const s = m.index ?? -1;
      const e = s + m[0].length;
      if (overlaps(s, e)) continue;
      // must contain either a year or a bracket number to count as a citation
      const cite = m[0];
      if (!(/\d{4}/.test(cite) || cite.startsWith('['))) continue;
      // Python: sent_lo = max(0, text.rfind(". ", 0, m.start()) + 1)
      const sentLo = Math.max(0, (s > 0 ? text.lastIndexOf('. ', s - 1) : -1) + 1);
      let sentHi = text.indexOf('. ', e);
      if (sentHi === -1) sentHi = Math.min(text.length, e + 200);
      // Python: " ".join(text[sent_lo:sent_hi].split())[:400]
      const claim = text
        .slice(sentLo, sentHi)
        .trim()
        .split(/\s+/)
        .join(' ')
        .slice(0, 400);
      hits.push({ cite, claim });
      seenSpans.push([s, e]);
      if (hits.length >= maxCitations) break outer;
    }
  }
  if (hits.length === 0) return '(no in-text citations detected)';
  return hits.map((h) => `- ${h.cite} :: ${h.claim}`).join('\n');
}

/**
 * BIBLIOGRAPHY stage: SMALL-role citation audit against the context pack.
 *
 * Slices mirror Python `_bibliography`: references[:30_000],
 * intext[:15_000], pack.render(max_items=25). Fail-soft: LLM error or
 * unparseable JSON returns the empty audit; only a budget cap is surfaced.
 */
export async function runBibliographyAudit(init: {
  callJson: CallJson;
  doc: Document;
  pack: ContextPack;
  /** Accepted for call-site parity with the other stage runners (unused). */
  settings?: unknown;
}): Promise<{ audit: BibliographyAudit; budget?: BudgetExceeded }> {
  const { callJson, doc, pack } = init;
  if (!doc.referencesText) return { audit: emptyAudit() };
  const intext = extractInTextCitations(doc);
  const user = bibliographyPrompt(
    doc.referencesText.slice(0, 30_000),
    intext.slice(0, 15_000),
    renderPack(pack, 25),
  );
  const res = await callJsonWithRepair(callJson, 'small', bibliographySystem, user);
  if (res.kind === 'budget') return { audit: emptyAudit(), budget: res.error };
  // Python catches LLMError (which the JSON-repair retry also raises) and
  // continues with the empty audit.
  if (res.kind !== 'ok') return { audit: emptyAudit() };
  const o =
    typeof res.value === 'object' && res.value !== null
      ? (res.value as Record<string, unknown>)
      : {};
  const arr = (key: string): BibAuditRecord[] => {
    const v = o[key];
    return Array.isArray(v) ? (v as BibAuditRecord[]) : [];
  };
  const audit: BibliographyAudit = {
    entries: arr('entries'),
    in_text_issues: arr('in_text_issues'),
    missing_key_references: arr('missing_key_references'),
  };
  return { audit };
}
