/** Render parity probe (dev-only): TS render vs Python render_markdown. */
import { readFileSync } from 'node:fs';
import { reportToMarkdown } from '../src/report/render';
import type { ReviewComment, ReviewReport } from '../src/report/models';

const expected = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  markdown: string;
};

const comments: ReviewComment[] = [
  {
    id: 'c001',
    title: 'Bootstrap assumption unstated',
    section: 'Methods',
    blockId: 'b2',
    paragraphAnchor: 'bootstrap with 999 replications',
    quote: '999 replications',
    comment: 'The replication count needs justification.',
    severity: 0.85,
    category: 'statistical',
    anchorConfidence: 1.0,
    provenance: 'claim_verify 2-of-2',
  },
  {
    id: 'c002',
    title: 'Duplicate label Figure 1',
    section: '1. Intro',
    blockId: 'b3',
    paragraphAnchor: 'Figure 1: the setup, again.',
    quote: 'Figure 1: the setup, again.',
    comment: 'Figure 1 is defined more than once; references to it are ambiguous.',
    severity: 0.45,
    category: 'reference',
    anchorConfidence: 1.0,
    provenance: 'deterministic',
  },
  {
    id: 'c003',
    title: 'Total row does not sum: Sales (tbl_doc_01)',
    section: '1. Data',
    quote: '',
    comment:
      'The "Total" row reports 1197 for "Sales", but the rows above sum to -1204.',
    severity: 0.7,
    category: 'consistency',
    anchorConfidence: 0.0,
    provenance: 'deterministic',
  },
  {
    id: 'c004',
    title: 'Generic LLM comment',
    section: '',
    quote: '',
    comment: 'No quote here.',
    severity: 0.3,
    category: 'general',
    anchorConfidence: 0.0,
  },
];

const report: ReviewReport = {
  paperTitle: 'Parity Paper',
  overall: '## Weaknesses\n\nThe proof of Lemma 2 is incomplete.',
  comments,
  copyeditItems: [
    {
      quote: 'bootstrap with 999 replications',
      suggestion: 'bootstrap with 1,000 replications',
      kind: 'grammar',
      section: 'Methods',
    },
  ],
  usage: {
    byRole: {},
    estimatedCostUsd: 0.0512,
    totalPromptTokens: 12000,
    totalCompletionTokens: 3400,
  },
  partial: false,
  generatedAt: '2026-10-29T12:30:00.000Z',
};

// The TS render has documented Stage-1 divergences vs origin/main Python
// (no run-id / paper-summary / build-metadata / attribution lines — the TS
// report model predates them). Compare on the STRUCTURE this stage ports:
// the findings/deterministic split, headers, tag lines, preambles, and
// comment bodies — by checking the Python output contains exactly the lines
// the TS produces for those parts.
const ts = reportToMarkdown(report);
const py = expected.markdown;

let failures = 0;
const expectContains = (needle: string, why: string) => {
  const inBoth = py.includes(needle) && ts.includes(needle);
  if (!inBoth) {
    failures++;
    console.log(
      `MISMATCH (${why}): not in both outputs\n  needle: ${JSON.stringify(needle)}`,
    );
    if (!py.includes(needle)) console.log('  (missing in PYTHON)');
    if (!ts.includes(needle)) console.log('  (missing in TS)');
  }
};

expectContains('## Findings (2)', 'findings count excludes deterministic');
expectContains('## Deterministic checks (2)', 'deterministic section');
expectContains(
  '_Sorted by relevance (severity). Provenance tags show how each finding ' +
    'was verified: `claim_verify 2-of-2` means it reproduced in two ' +
    'independent passes; `arbitrated` findings passed a strong-model gate; ' +
    '`auditor` entries were produced or cross-checked by a second model._',
  'findings preamble',
);
expectContains(
  '_Produced by code, not language models: cross-reference resolution, ' +
    'number consistency, table arithmetic, formula recomputation ' +
    '(sympy), and reference resolution against Crossref/OpenAlex._',
  'deterministic preamble',
);
expectContains(
  '### 1. Bootstrap assumption unstated  — _Methods_',
  'header shape (title + section)',
);
expectContains(
  '_[severity 0.85] · [statistical] · [claim_verify 2-of-2]_',
  'tag line with provenance',
);
expectContains(
  '### 2. Generic LLM comment \n_[severity 0.30] · [general]_',
  'header w/o section: trailing space kept (Python f-string, no rstrip)',
);
expectContains('> 999 replications', 'quote blockquote');
expectContains(
  '### 1. Total row does not sum: Sales (tbl_doc_01)  — _1. Data_',
  'deterministic header 1',
);
expectContains(
  '_[severity 0.70] · [consistency] · [deterministic]_',
  'deterministic badge',
);
expectContains(
  '### 2. Duplicate label Figure 1  — _1. Intro_',
  'deterministic header 2 (severity order 0.7 before 0.45)',
);
expectContains('> Figure 1: the setup, again.', 'deterministic quote');
expectContains(
  'The "Total" row reports 1197 for "Sales", but the rows above sum to -1204.',
  'message body without quote: header, tag, message',
);
// deterministic comments must NOT appear under Findings: the LLM section of
// both outputs ends before the deterministic section starts
const pyFindings = py.slice(
  py.indexOf('## Findings'),
  py.indexOf('## Deterministic checks'),
);
const tsFindings = ts.slice(
  ts.indexOf('## Findings'),
  ts.indexOf('## Deterministic checks'),
);
if (
  pyFindings.includes('Duplicate label Figure 1') ||
  tsFindings.includes('Duplicate label Figure 1')
) {
  failures++;
  console.log('MISMATCH: deterministic comment leaked into Findings');
}
if (failures === 0) console.log('RENDER PARITY GREEN (structure)');
else process.exit(1);
