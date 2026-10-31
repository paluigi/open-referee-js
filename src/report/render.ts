/**
 * Markdown rendering of the review report.
 *
 * Port of the markdown path of Python `open_referee/report/render.py`
 * (`render_markdown`), structure-faithful to the Python output: comments
 * split by provenance into Findings (LLM) and Deterministic checks, the
 * `_comment_header` shape (`### {i}. {title} — _{section}_` + the
 * bracketed-badge tag line), and the per-comment quote + message body.
 */

import type { ReviewReport } from './models';
import type { ReviewComment } from '../report/models';
import { sortedComments } from './models';

/** Python `_DETERMINISTIC_PROVENANCE`. */
const DETERMINISTIC_PROVENANCE = ['deterministic', 'recompute'];

function utcTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} UTC`;
}

/** Python `_comment_header`: `### {i}. {title} — _{section}_` + tag line. */
function commentHeader(i: number, c: ReviewComment): { header: string; tag: string } {
  const badges = [`severity ${c.severity.toFixed(2)}`, c.category || 'general'];
  if (c.provenance) badges.push(c.provenance);
  const tag = badges.map((b) => `[${b}]`).join(' · ');
  const sec = c.section ? ` — _${c.section}_` : '';
  // Python keeps the trailing space when section is empty (no rstrip there).
  return { header: `### ${i}. ${c.title ?? ''} ${sec}`, tag };
}

/** Body lines shared by both comment sections (Python loop, verbatim shape). */
function commentLines(out: string[], i: number, c: ReviewComment): void {
  const { header, tag } = commentHeader(i, c);
  out.push(header);
  out.push(`_${tag}_`);
  if (c.quote) {
    out.push('', `> ${c.quote}`);
  }
  out.push('', c.comment, '');
}

/** Python `render_markdown`, character-faithful in structure. */
export function reportToMarkdown(report: ReviewReport): string {
  const parts: string[] = [`# Review report — ${report.paperTitle}`, ''];
  parts.push(`_Generated ${utcTimestamp(report.generatedAt)}_`);
  if (report.recommendation) {
    parts.push(`_Recommendation — ${report.recommendation}_`);
  }
  if (report.partial) {
    parts.push('_PARTIAL REPORT: the run stopped early; sections may be missing._');
  }
  parts.push('', '## Overall feedback', '', report.overall || '_(none)_', '');

  // Findings by relevance (severity), deterministic ones in their own section.
  const llmComments = sortedComments(report).filter(
    (c) => !DETERMINISTIC_PROVENANCE.includes(c.provenance ?? ''),
  );
  const detComments = sortedComments(report).filter((c) =>
    DETERMINISTIC_PROVENANCE.includes(c.provenance ?? ''),
  );
  parts.push(`## Findings (${llmComments.length})`, '');
  parts.push(
    '_Sorted by relevance (severity). Provenance tags show how each finding ' +
      'was verified: `claim_verify 2-of-2` means it reproduced in two ' +
      'independent passes; `arbitrated` findings passed a strong-model gate; ' +
      '`auditor` entries were produced or cross-checked by a second model._',
  );
  parts.push('');
  llmComments.forEach((c, i) => commentLines(parts, i + 1, c));
  if (detComments.length > 0) {
    parts.push(`## Deterministic checks (${detComments.length})`, '');
    parts.push(
      '_Produced by code, not language models: cross-reference resolution, ' +
        'number consistency, table arithmetic, formula recomputation ' +
        '(sympy), and reference resolution against Crossref/OpenAlex._',
    );
    parts.push('');
    detComments.forEach((c, i) => commentLines(parts, i + 1, c));
  }
  // Python order: findings -> validator notes -> copyedit table -> usage.
  if (report.copyeditItems && report.copyeditItems.length > 0) {
    parts.push(
      `## Suggested language fixes (${report.copyeditItems.length})`,
      '',
      '_Mechanical language items from the copyedit pass — typos, grammar, ' +
        'phrasing, terminology. Each quote is verified to appear in the ' +
        'manuscript; these are copyedits, not findings, and carry no ' +
        'severity._',
      '',
      '| # | Kind | Location | Original | Suggested fix |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const [i, it] of report.copyeditItems.entries()) {
      const q = it.quote.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const s = it.suggestion.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      parts.push(`| ${i + 1} | ${it.kind} | ${it.section || '—'} | ${q} | ${s} |`);
    }
    parts.push('');
  }
  const u = report.usage;
  if (u.estimatedCostUsd || u.totalPromptTokens) {
    parts.push(
      '## Usage',
      '',
      `Input tokens: ${u.totalPromptTokens.toLocaleString('en-US')} · Output tokens: ` +
        `${u.totalCompletionTokens.toLocaleString('en-US')} · ` +
        `Estimated cost: $${u.estimatedCostUsd.toFixed(4)}`,
      '',
    );
  }
  return parts.join('\n');
}
