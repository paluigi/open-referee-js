import { describe, expect, it } from 'vitest';
import { reportToMarkdown } from '../src/report/render';
import type { ReviewComment, ReviewReport } from '../src/report/models';
import { sortedComments } from '../src/report/models';

function comment(partial: Partial<ReviewComment>): ReviewComment {
  return {
    section: 'Section 1',
    quote: 'quoted text',
    comment: 'what is wrong and why',
    severity: 0.5,
    ...partial,
  };
}

function report(partial: Partial<ReviewReport> = {}): ReviewReport {
  return {
    paperTitle: 'Test Paper',
    overall: '## Weaknesses\n\nThe proof of Lemma 2 is incomplete.',
    comments: [],
    usage: {
      byRole: {},
      estimatedCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
    partial: false,
    generatedAt: '2026-10-16T14:00:00.000Z',
    ...partial,
  };
}

describe('sortedComments', () => {
  it('sorts by severity descending without mutating the input', () => {
    const r = report({
      comments: [
        comment({ severity: 0.2 }),
        comment({ severity: 0.9 }),
        comment({ severity: 0.6 }),
      ],
    });
    const sorted = sortedComments(r);
    expect(sorted.map((c) => c.severity)).toEqual([0.9, 0.6, 0.2]);
    expect(r.comments.map((c) => c.severity)).toEqual([0.2, 0.9, 0.6]);
  });
});

describe('reportToMarkdown', () => {
  it('renders the Python render_markdown structure', () => {
    const md = reportToMarkdown(
      report({
        comments: [
          comment({
            title: 'Broken finding',
            severity: 0.85,
            section: 'Section 3',
            quote: 'the span',
            comment: 'broken',
          }),
          comment({ title: 'Untitled finding', severity: 0.3, quote: '', section: '' }),
        ],
        usage: {
          byRole: {},
          estimatedCostUsd: 0.0123,
          totalPromptTokens: 12000,
          totalCompletionTokens: 3400,
        },
      }),
    );
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Review report — Test Paper');
    expect(md).toContain('_Generated 2026-10-16 14:00 UTC_');
    expect(md).toContain('## Overall feedback');
    expect(md).toContain('The proof of Lemma 2 is incomplete.');
    // provenance-less comments render under Findings (Python split)
    expect(md).toContain('## Findings (2)');
    expect(md).not.toContain('## Deterministic checks');
    // Python _comment_header shape: ### {i}. {title} — _{section}_ + tag line
    expect(md).toContain('### 1. Broken finding  — _Section 3_');
    expect(md).toContain('_[severity 0.85] · [general]_');
    expect(md).toContain('> the span');
    // no section: the f-string keeps the trailing space; category defaults
    expect(md).toContain('### 2. Untitled finding \n_[severity 0.30] · [general]_');
    expect(md).toContain(
      'Input tokens: 12,000 · Output tokens: 3,400 · Estimated cost: $0.0123',
    );
    // no usage section when usage is empty
    const empty = reportToMarkdown(report());
    expect(empty).not.toContain('## Usage');
  });

  it('renders the recommendation when present and omits it otherwise', () => {
    expect(reportToMarkdown(report({ recommendation: 'major revision' }))).toContain(
      '_Recommendation — major revision_',
    );
    expect(reportToMarkdown(report())).not.toContain('Recommendation');
  });

  it('marks partial reports', () => {
    expect(reportToMarkdown(report({ partial: true }))).toContain('PARTIAL REPORT');
    expect(reportToMarkdown(report())).not.toContain('PARTIAL REPORT');
  });

  it('renders the copyedit annex exactly as Python render.py', () => {
    const md = reportToMarkdown(
      report({
        copyeditItems: [
          {
            quote: 'bootstrap with 999 replications',
            suggestion: 'bootstrap with 1,000 replications',
            kind: 'grammar',
            section: 'Methods',
          },
          {
            quote: 'pipe | and\nnewline',
            suggestion: 'cleaned',
            kind: 'typo',
            section: null,
          },
        ],
      }),
    );
    expect(md).toContain('## Suggested language fixes (2)');
    expect(md).toContain(
      '_Mechanical language items from the copyedit pass — typos, grammar, ' +
        'phrasing, terminology. Each quote is verified to appear in the ' +
        'manuscript; these are copyedits, not findings, and carry no ' +
        'severity._',
    );
    expect(md).toContain('| # | Kind | Location | Original | Suggested fix |');
    expect(md).toContain('| --- | --- | --- | --- | --- |');
    expect(md).toContain(
      '| 1 | grammar | Methods | bootstrap with 999 replications | ' +
        'bootstrap with 1,000 replications |',
    );
    // pipe and newline escaped in cells; null section falls back to '—'
    expect(md).toContain('| 2 | typo | — | pipe \\| and newline | cleaned |');
    // no section when there are no items
    expect(reportToMarkdown(report())).not.toContain('Suggested language fixes');
  });

  it('falls back to _(none)_ for empty overall text', () => {
    expect(reportToMarkdown(report({ overall: '' }))).toContain('_(none)_');
  });

  it('splits deterministic-provenance comments into their own section (Python _DETERMINISTIC_PROVENANCE)', () => {
    const md = reportToMarkdown(
      report({
        comments: [
          comment({
            title: 'LLM finding',
            severity: 0.85,
            category: 'statistical',
            provenance: 'claim_verify 2-of-2',
          }),
          comment({
            title: 'Duplicate label Figure 1',
            severity: 0.45,
            quote: 'Figure 1: the setup, again.',
            category: 'reference',
            provenance: 'deterministic',
          }),
          comment({
            title: 'Recomputed mismatch',
            severity: 0.7,
            category: 'consistency',
            provenance: 'recompute',
          }),
          comment({ title: 'Unbadged finding', severity: 0.3 }),
        ],
      }),
    );
    // counts exclude deterministic/recompute from Findings
    expect(md).toContain('## Findings (2)');
    expect(md).toContain('## Deterministic checks (2)');
    // deterministic section lists by severity desc, renumbered from 1;
    // titles carry through, section renders in the header
    expect(md).toContain('### 1. Recomputed mismatch  — _Section 1_');
    expect(md).toContain('_[severity 0.70] · [consistency] · [recompute]_');
    expect(md).toContain('### 2. Duplicate label Figure 1  — _Section 1_');
    expect(md).toContain('_[severity 0.45] · [reference] · [deterministic]_');
    // deterministic comments must not leak into Findings
    const findings = md.slice(
      md.indexOf('## Findings'),
      md.indexOf('## Deterministic checks'),
    );
    expect(findings).not.toContain('Duplicate label');
    expect(findings).not.toContain('Recomputed mismatch');
    // both preambles verbatim (Python render.py)
    expect(md).toContain(
      '_Sorted by relevance (severity). Provenance tags show how each finding ' +
        'was verified: `claim_verify 2-of-2` means it reproduced in two ' +
        'independent passes; `arbitrated` findings passed a strong-model gate; ' +
        '`auditor` entries were produced or cross-checked by a second model._',
    );
    expect(md).toContain(
      '_Produced by code, not language models: cross-reference resolution, ' +
        'number consistency, table arithmetic, formula recomputation ' +
        '(sympy), and reference resolution against Crossref/OpenAlex._',
    );
    // no deterministic section when nothing carries the provenance
    expect(reportToMarkdown(report())).not.toContain('## Deterministic checks');
  });
});

describe('comment title fallback (7b review fix)', () => {
  it('renders the Python assemble fallback for missing LLM titles', () => {
    const rep = report({
      comments: [
        comment({ section: 'S', quote: 'q', comment: 'msg', severity: 0.3 }),
        comment({
          section: 'S2',
          quote: 'q2',
          comment: 'msg2',
          severity: 0.4,
          title: 'Real title',
          provenance: 'deterministic',
        }),
      ],
    });
    const md = reportToMarkdown(rep);
    // Sections split by provenance; numbering restarts per section; the
    // header keeps Python's f-string spacing ('title' + ' ' + ' — _sec_'
    // = two spaces when section present).
    expect(md).toContain('### 1. Real title  — _S2_');
    expect(md).toContain('### 1.   — _S_');
  });
});
