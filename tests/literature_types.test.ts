import { describe, expect, it } from 'vitest';
import {
  newContextPack,
  normalizeTitleKey,
  renderPack,
  type BibEntryCheck,
  type ContextPack,
  type LiteratureItem,
} from '../src/literature/types';

/**
 * Expected strings generated from the Python reference:
 *   cd ~/coding/open-referee && uv run python -c "...print(repr(pack.render()))"
 * (same PY_* expected-constant pattern as tests/prompts_claims.test.ts).
 */
const PY_RENDER_FULL =
  '# Field context pack (paper: Scaling Laws for Sparse Models)\n' +
  'Detected field: machine learning / efficient inference\n' +
  'Author-supplied related work (prioritized reading): Related: Pruning at Scale; Author Notes Draft\n' +
  '1. Attention Is All You Need — Vaswani, Shazeer, Parmar (2017) [NeurIPS] doi:10.5555/3295222.3295349 cited_by:90000\n' +
  '   abstract: ' +
  ('The dominant sequence transduction models are based on ' + 'x'.repeat(700)).slice(
    0,
    700,
  ) +
  '…\n' +
  '2. A Blog Post on Sparsity\n' +
  '   abstract: short one\n' +
  '   relevance: Recent context on sparsity trends.\n' +
  '3. Deep Residual Learning — He, Zhang (2016) [CVPR] cited_by:0\n' +
  '   relevance: Seminal architecture.\n' +
  '4. Author-Supplied Survey (2024)\n' +
  '   relevance: Author-supplied related work\n' +
  '\nBibliography entries needing attention:\n' +
  '- [not_found] Smith, J. (2019). Ghost paper. J. Nowhere. — no match in Crossref\n' +
  '- [year_mismatch] Wu, L. (2015). Old result. Nature. — year differs';

function makePack(): ContextPack {
  const pack = newContextPack('Scaling Laws for Sparse Models');
  pack.paperAbstract = 'We study scaling.';
  pack.fieldHint = 'machine learning / efficient inference';
  pack.userDocs = ['Related: Pruning at Scale', 'Author Notes Draft'];
  const long =
    'The dominant sequence transduction models are based on ' + 'x'.repeat(700);
  pack.items = [
    {
      source: 'openalex',
      title: 'Attention Is All You Need',
      authors: ['Vaswani', 'Shazeer', 'Parmar'],
      year: 2017,
      doi: '10.5555/3295222.3295349',
      venue: 'NeurIPS',
      citedBy: 90000,
      abstract: long,
      url: 'https://openalex.org/W2963403868',
    },
    {
      source: 'web',
      title: 'A Blog Post on Sparsity',
      authors: [],
      abstract: 'short one',
      whyRelevant: 'Recent context on sparsity trends.',
    },
    {
      source: 'crossref',
      title: 'Deep Residual Learning',
      authors: ['He', 'Zhang'],
      year: 2016,
      venue: 'CVPR',
      citedBy: 0,
      whyRelevant: 'Seminal architecture.',
    },
    {
      source: 'user_pdf',
      title: 'Author-Supplied Survey',
      authors: [],
      year: 2024,
      whyRelevant: 'Author-supplied related work',
    },
  ];
  const checks: BibEntryCheck[] = [
    {
      rawEntry: 'Smith, J. (2019). Ghost paper. J. Nowhere.',
      status: 'not_found',
      note: 'no match in Crossref',
    },
    { rawEntry: 'Lee, K. (2020). Verified paper.', status: 'verified' },
    {
      rawEntry: 'Wu, L. (2015). Old result. Nature.',
      matchedYear: 2016,
      status: 'year_mismatch',
      note: 'year differs',
    },
  ];
  pack.bibChecks = checks;
  return pack;
}

describe('renderPack parity vs Python ContextPack.render', () => {
  it('default args: identical output to the Python reference', () => {
    expect(renderPack(makePack())).toBe(PY_RENDER_FULL);
  });

  it('maxItems/maxAbstractChars branches match the Python reference', () => {
    const expected =
      '# Field context pack (paper: Scaling Laws for Sparse Models)\n' +
      'Detected field: machine learning / efficient inference\n' +
      'Author-supplied related work (prioritized reading): Related: Pruning at Scale; Author Notes Draft\n' +
      '1. Attention Is All You Need — Vaswani, Shazeer, Parmar (2017) [NeurIPS] doi:10.5555/3295222.3295349 cited_by:90000\n' +
      '   abstract: The dominant sequence transduction model…\n' +
      '2. A Blog Post on Sparsity\n' +
      '   abstract: short one\n' +
      '   relevance: Recent context on sparsity trends.\n' +
      '\nBibliography entries needing attention:\n' +
      '- [not_found] Smith, J. (2019). Ghost paper. J. Nowhere. — no match in Crossref\n' +
      '- [year_mismatch] Wu, L. (2015). Old result. Nature. — year differs';
    expect(renderPack(makePack(), 2, 40)).toBe(expected);
  });

  it('minimal pack: only the header line', () => {
    expect(renderPack(newContextPack('Bare'))).toBe(
      '# Field context pack (paper: Bare)',
    );
  });
});

describe('normalizeTitleKey (Python re.sub dedupe key)', () => {
  it('strips non-word chars, lowercases, clips to 80', () => {
    expect(normalizeTitleKey('  Attention  Is All — You Need! ')).toBe(
      'attentionisallyouneed',
    );
    const long = 'A'.repeat(100);
    expect(normalizeTitleKey(long)).toHaveLength(80);
  });
});

describe('pack shape', () => {
  it('newContextPack gives empty arrays, no field hints', () => {
    const p = newContextPack('T');
    expect(p.items).toEqual([]);
    expect(p.bibChecks).toEqual([]);
    expect(p.userDocs).toEqual([]);
    expect(p.fieldHint).toBeUndefined();
    expect(p.paperAbstract).toBeUndefined();
  });

  it('citedBy:0 still renders (Python `is not None` check)', () => {
    const p = newContextPack('T');
    const item: LiteratureItem = {
      source: 'openalex',
      title: 'X',
      authors: [],
      citedBy: 0,
    };
    p.items = [item];
    expect(renderPack(p)).toBe('# Field context pack (paper: T)\n1. X cited_by:0');
  });
});
