import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectTables,
  documentFromPdf,
  pdfItemsToLines,
  tableToMarkdown,
} from '../src/ingestion/pdf';
import type { TextItemLike } from '../src/ingestion/pdf';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'minimal.pdf');

function readFixture(): Uint8Array {
  const buf = readFileSync(FIXTURE);
  return new Uint8Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

function item(str: string, x: number, y: number): TextItemLike {
  return { str, transform: [1, 0, 0, 1, x, y] };
}

describe('pdfItemsToLines (joining heuristic)', () => {
  it('joins items sharing a baseline into one line, ordered by x', () => {
    const lines = pdfItemsToLines([
      item('world', 200, 700),
      item('Hello ', 72, 700),
      item('next line', 72, 650),
    ]);
    expect(lines).toEqual(['Hello world', 'next line']);
  });

  it('orders lines top-to-bottom (pdf y is bottom-up)', () => {
    const lines = pdfItemsToLines([item('bottom', 72, 100), item('top', 72, 500)]);
    expect(lines).toEqual(['top', 'bottom']);
  });

  it('skips empty items (pdf.js emits zero-length separators)', () => {
    const lines = pdfItemsToLines([item('', 0, 0), item('text', 72, 700)]);
    expect(lines).toEqual(['text']);
  });
});

describe('tableToMarkdown (Python _table_to_markdown port)', () => {
  it('renders cells with None -> empty and synthesized separator', () => {
    const md = tableToMarkdown([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(md).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
  });

  it('escapes pipes and flattens newlines', () => {
    const md = tableToMarkdown([
      ['x|y', 'a\nb'],
      ['1', '2'],
    ]);
    expect(md).toContain('| x\\-y | a b |');
  });

  it('returns empty for no cells', () => {
    expect(tableToMarkdown([])).toBe('');
  });
});

describe('detectTables (heuristic clusterer)', () => {
  it('finds an aligned 2x3 grid', () => {
    const items = [
      item('col1', 72, 700),
      item('col2', 200, 700),
      item('1', 72, 680),
      item('2', 200, 680),
      item('3', 72, 660),
      item('4', 200, 660),
    ];
    const tables = detectTables(items);
    expect(tables).toHaveLength(1);
    const matrix = tables[0]!;
    expect(matrix).toHaveLength(3);
    expect(matrix[0]).toEqual(['col1', 'col2']);
    expect(matrix[2]).toEqual(['3', '4']);
  });

  it('returns [] for unaligned text', () => {
    const items = [item('some paragraph text', 72, 700), item('more prose', 90, 680)];
    expect(detectTables(items)).toEqual([]);
  });
});

describe('documentFromPdf (fixture end-to-end)', () => {
  it('extracts the fixture text, heading, and proportional page mapping', async () => {
    const doc = await documentFromPdf(readFixture(), 'minimal');
    expect(doc.sourceFormat).toBe('pdf');
    expect(doc.title).toBe('minimal');
    const md = doc.blocks.map((b) => `${b.type}:${b.text}`).join('\n');
    expect(md).toContain('3. Main result');
    expect(md).toContain('Every widget is stable');
    // proportional mapping: single page -> every block on page 1
    for (const b of doc.blocks) {
      expect(b.page).toBe(1);
    }
  });

  it('goes through the _pdf_text_to_markdown heading path', async () => {
    const doc = await documentFromPdf(readFixture(), 'minimal');
    const headings = doc.blocks.filter((b) => b.text === '3. Main result');
    expect(headings).toHaveLength(1);
  });

  it('detectTables stays fast on a dense per-glyph page (perf regression)', () => {
    // 32k distinct-baseline items (per-glyph runs from some generators) —
    // the pre-frontier implementation took ~9 s here (O(items x rows)).
    const items: TextItemLike[] = [];
    for (let i = 0; i < 32_000; i++) {
      items.push(item(`g${i}`, (i % 7) * 60, 700 - i * 0.4));
    }
    const t0 = performance.now();
    const tables = detectTables(items);
    const ms = performance.now() - t0;
    expect(tables.length).toBeLessThanOrEqual(1);
    expect(ms).toBeLessThan(1000);
  });

  it('detectTables still finds an aligned grid after the frontier change', () => {
    // 3 rows x 3 aligned columns
    const items: TextItemLike[] = [];
    for (let r = 0; r < 3; r++) {
      for (let cIdx = 0; cIdx < 3; cIdx++) {
        items.push(item(`r${r}c${cIdx}`, 70 + cIdx * 100, 700 - r * 20));
      }
    }
    const tables = detectTables(items);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toHaveLength(3);
  });

  it('produces no figures (documented v1 deviation) and no spurious tables', async () => {
    const doc = await documentFromPdf(readFixture(), 'minimal');
    expect(doc.figures).toEqual([]);
    expect(doc.tables).toEqual([]);
  });
});
