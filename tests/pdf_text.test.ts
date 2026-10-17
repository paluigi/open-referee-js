import { describe, expect, it } from 'vitest';
import { pdfTextToMarkdown } from '../src/ingestion/pdf_text';

// Port of Python tests/test_ingestion.py::test_pdf_text_heuristics (verbatim).
describe('pdfTextToMarkdown: heuristics (Python test port)', () => {
  it('promotes numbered headings to ##', () => {
    const raw = `On the Stability of Widget Networks
3. Main result

We now state the theorem.
Theorem 1. Every widget is stable.`;
    const md = pdfTextToMarkdown(raw);
    expect(md).toContain('## 3. Main result');
  });
});

describe('pdfTextToMarkdown: additional cases', () => {
  it('promotes Appendix headings', () => {
    const md = pdfTextToMarkdown('Appendix A Proof details\nThe full proof is here.');
    expect(md).toContain('## Appendix A Proof details');
  });

  it('passes plain text through unchanged (single paragraph, joined lines)', () => {
    const md = pdfTextToMarkdown('one\ntwo\nthree');
    expect(md).toBe('one two three');
  });

  it('blank lines become paragraph separators (empty paras dropped)', () => {
    const md = pdfTextToMarkdown('para one\n\n\npara two');
    expect(md).toBe('para one\n\npara two');
  });

  it('handles CRLF line endings', () => {
    const md = pdfTextToMarkdown(
      'First para\r\nstill first\r\n\r\n2. Methods\r\nBody.',
    );
    expect(md).toContain('## 2. Methods');
    expect(md).toContain('First para still first');
    expect(md).toContain('Body.');
  });

  it('long numbered lines (>=130 chars) are NOT headings', () => {
    const long = '1. ' + 'x'.repeat(135);
    const md = pdfTextToMarkdown(long);
    expect(md).not.toContain('## ');
    expect(md).toBe(long.trim());
  });

  it('absorbs a numbered heading directly after a paragraph and keeps paragraph joins', () => {
    const raw = `3. Main result

We now state the theorem.
Theorem 1. Every widget is stable.`;
    const md = pdfTextToMarkdown(raw);
    expect(md).toBe(
      '## 3. Main result\n\nWe now state the theorem. Theorem 1. Every widget is stable.',
    );
  });

  it('round-trips through documentFromMarkdown with sections intact', async () => {
    const { documentFromMarkdown } = await import('../src/ingestion/readers_md');
    const raw = `Title Line
1. Introduction
Some intro text here
3. Main result
Theorem 1. Every widget is stable.`;
    const md = pdfTextToMarkdown(raw);
    const doc = documentFromMarkdown(md, 'pdf', 'fixture');
    expect(doc.sectionTitles()).toContain('1. Introduction');
    expect(doc.sectionTitles()).toContain('3. Main result');
  });
});
