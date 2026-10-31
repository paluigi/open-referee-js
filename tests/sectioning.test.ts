import { describe, expect, it } from 'vitest';
import { documentFromMarkdown } from '../src/ingestion/readers_md';
import { splitByHeadings } from '../src/pipeline/orchestrator';

// Parity pins of Python tests/test_sectioning.py (e5eedfa): HTML-anchored
// markdown headings + the heading-heuristic fallback split.

const ANCHORED =
  `# Title

Author One, Author Two

Abstract

Filler abstract text. ` +
  'word '.repeat(120) +
  `

<a id="introduction"></a>## 1 Introduction

First section body. ` +
  'sentence '.repeat(200) +
  `

<a id="conclusions"></a>## 5 Conclusions

Closing body. ` +
  'sentence '.repeat(200);

const PLAIN =
  `Paper title line

Some front matter. ` +
  'text '.repeat(200) +
  `

1. Introduction

Intro body. ` +
  'sentence '.repeat(200) +
  `

2.3 Methods and data

Methods body. ` +
  'sentence '.repeat(200) +
  `

CONCLUSIONS

Conclusions body. ` +
  'sentence '.repeat(200);

describe('sectioning: HTML-anchored headings (e5eedfa)', () => {
  it('anchored markdown headings produce sections; anchors never leak into blocks', () => {
    const doc = documentFromMarkdown(ANCHORED, 'md', 't');
    const titles = doc.sections.map((s) => s.title);
    expect(titles).toContain('1 Introduction');
    expect(titles).toContain('5 Conclusions');
    for (const b of doc.blocks) {
      expect(b.text.includes('<a id=')).toBe(false);
    }
  });
});

describe('splitByHeadings parity (_split_by_headings)', () => {
  it('detects numbered and caps headings', () => {
    const out = splitByHeadings(PLAIN);
    const titles = out.map((s) => s.title);
    expect(titles).toContain('1. Introduction');
    expect(titles).toContain('2.3 Methods and data');
    expect(titles).toContain('Conclusions'); // keyword heading branch title-cases (Python s.title())
    for (const s of out) {
      expect(s.text.length).toBeGreaterThan(200);
    }
  });

  it('merges small chunks and ignores author-list caps lines', () => {
    const text =
      'ANDREA GALEOTTI, BENJAMIN GOLUB, SANJEEV GOYAL\n\n' +
      'Abstract\n\n' +
      'abstract text. '.repeat(80) +
      '\n\n' +
      '## 1 Introduction\n\n' +
      'body. '.repeat(200) +
      '\n\n' +
      '## 2 Short\n\ntiny\n\n' +
      '## 3 More\n\n' +
      'body. '.repeat(200);
    const out = splitByHeadings(text);
    const titles = out.map((s) => s.title);
    // author-list caps line must NOT become a section boundary
    expect(titles.some((t) => t.includes('GALEOTTI'))).toBe(false);
    // the tiny "## 2 Short" chunk merges into a neighbour
    expect(titles).not.toContain('2 Short');
    expect(titles).toContain('1 Introduction');
  });

  it('caps headings without commas become boundaries', () => {
    const text =
      'INTRODUCTION\n\n' +
      'body '.repeat(200) +
      '\n\nRESULTS\n\n' +
      'body '.repeat(200);
    const out = splitByHeadings(text);
    expect(out.map((s) => s.title)).toEqual(['INTRODUCTION', 'RESULTS']);
  });

  it('returns [] when no headings exist', () => {
    expect(splitByHeadings('just one long paragraph '.repeat(500))).toEqual([]);
  });
});
