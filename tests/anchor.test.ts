import { describe, expect, it } from 'vitest';
import { resolveAnchor, sectionOfBlock } from '../src/report/anchor';
import { Block, Document } from '../src/ingestion/document';

function makeDoc(): Document {
  return new Document({
    title: 'T',
    blocks: [
      new Block({
        id: 'b1',
        text: 'We prove the main theorem via convex duality.',
        sectionPath: ['1', 'Introduction'],
      }),
      new Block({
        id: 'b2',
        text: 'The bootstrap uses 999 replications throughout.',
        sectionPath: ['3', 'Methods'],
      }),
      new Block({
        id: 'b3',
        text: 'A unique sentence used twice, once here.',
        sectionPath: [],
      }),
      new Block({
        id: 'b4',
        text: 'A unique sentence used twice, once here (duplicate).',
        sectionPath: ['4', 'Appendix'],
      }),
    ],
  });
}

describe('resolveAnchor (Python _resolve_anchor port)', () => {
  it('unique anchor hit -> 1.0', () => {
    const doc = makeDoc();
    const r = resolveAnchor(doc, 'bootstrap uses 999 replications', '');
    expect(r).toEqual({ blockId: 'b2', confidence: 1.0 });
  });

  it('multi anchor hit -> first block at 0.7', () => {
    const doc = makeDoc();
    const r = resolveAnchor(doc, 'A unique sentence used twice, once here', '');
    expect(r.blockId).toBe('b3');
    expect(r.confidence).toBe(0.7);
  });

  it('anchor miss but quote hit -> 0.6', () => {
    const doc = makeDoc();
    const r = resolveAnchor(
      doc,
      'this anchor appears nowhere in the document at all',
      '999 replications throughout',
    );
    expect(r).toEqual({ blockId: 'b2', confidence: 0.6 });
  });

  it('token-overlap Jaccard fallback > 0.35', () => {
    const doc = makeDoc();
    // no exact substring hits; tokens mostly overlap with b1
    const r = resolveAnchor(
      doc,
      'We prove the main theorem via convex duality arguments here.',
      '',
    );
    expect(r.blockId).toBe('b1');
    expect(r.confidence).toBeGreaterThan(0.35);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('total miss -> null / 0.0', () => {
    const doc = makeDoc();
    const r = resolveAnchor(doc, 'zebra quantum banana', 'xylophone');
    expect(r).toEqual({ blockId: null, confidence: 0.0 });
  });
});

describe('sectionOfBlock (Python _section_of_block port)', () => {
  it('returns the first section-path segment', () => {
    const doc = makeDoc();
    expect(sectionOfBlock(doc, 'b2')).toBe('3');
    expect(sectionOfBlock(doc, 'b1')).toBe('1');
  });
  it('null block / empty path / unknown id -> null', () => {
    const doc = makeDoc();
    expect(sectionOfBlock(doc, null)).toBeNull();
    expect(sectionOfBlock(doc, 'b3')).toBeNull();
    expect(sectionOfBlock(doc, 'missing')).toBeNull();
  });
});
