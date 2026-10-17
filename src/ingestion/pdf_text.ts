/**
 * Heuristic PDF text -> markdown.
 *
 * Port of Python `open_referee/ingestion/readers.py::_pdf_text_to_markdown`
 * (L214-242): paragraphs joined from consecutive non-empty, non-heading lines;
 * headings detected from numbered-section lines ("3. Main result",
 * "Appendix A Something") with the len<130 guard. The heading regex is the
 * exact NUMBERED_HEADING_RE already ported in readers_md.ts.
 */

import { NUMBERED_HEADING_RE } from './readers_md';

/**
 * Python `_pdf_text_to_markdown`: split into lines, promote numbered headings,
 * drop blank-line gaps into empty strings, then join consecutive non-heading
 * lines with single spaces and emit paragraphs separated by blank lines.
 */
export function pdfTextToMarkdown(text: string): string {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/u, '');
    if (!line.trim()) {
      out.push('');
      continue;
    }
    const m = NUMBERED_HEADING_RE.exec(line.trim());
    if (m && line.trim().length < 130) {
      out.push(`## ${line.trim()}`);
    } else {
      out.push(line);
    }
  }
  // join consecutive non-empty, non-heading lines into paragraphs
  const paras: string[] = [];
  let buf: string[] = [];
  for (const line of out) {
    if (line.startsWith('## ') || !line.trim()) {
      if (buf.length > 0) {
        paras.push(buf.join(' '));
        buf = [];
      }
      if (line.trim()) {
        paras.push(line);
      }
    } else {
      buf.push(line.trim());
    }
  }
  if (buf.length > 0) {
    paras.push(buf.join(' '));
  }
  return paras.join('\n\n');
}
