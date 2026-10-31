/**
 * Parity probe (dev-only, not part of the test suite): run the TS checkers
 * on the same fixtures as the Python harness and diff against expected.json.
 * Run: npx tsx scripts/checkers_parity_probe.ts <expected.json>
 */
import { readFileSync } from 'node:fs';
import { Block, BlockType, Document, Section } from '../src/ingestion/document';
import type {
  Figure,
  TableArtifact,
  TheoremEnvironment,
} from '../src/ingestion/document';
import {
  crossReferenceCheck,
  numberConsistencyCheck,
  runDeterministicChecks,
  tableArithmeticCheck,
  gFormat,
} from '../src/pipeline/checkers';

const expected = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));

const B = (id: string, type: BlockType, text: string, sectionPath: string[] = []) =>
  new Block({ id, type, text, sectionPath, order: 0 });

const xrefBlocks = [
  B('b0', BlockType.TITLE, 'Parity Paper'),
  B('b1', BlockType.HEADING, '1. Intro', ['1. Intro']),
  B(
    'b2',
    BlockType.PARAGRAPH,
    'Figure 1: the setup. See Section 4 for details. Also Figure 9 plots ' +
      'the residual diagnostic and Section 5.2 expands the argument.',
    ['1. Intro'],
  ),
  B('b3', BlockType.CAPTION, 'Figure 1: the setup, again.', ['1. Intro']),
  B(
    'b4',
    BlockType.PARAGRAPH,
    'Theorem 3. First result.\n\nTheorem 1. Second result.\n\nTheorem 2. Third result.',
    ['1. Intro'],
  ),
  B(
    'b5',
    BlockType.PARAGRAPH,
    'By Theorem 4 the claim follows, and Lemma 1 gives the bound used later.',
    ['1. Intro'],
  ),
];
const xrefDoc = new Document({
  title: 'Parity Paper',
  blocks: xrefBlocks,
  sections: [
    new Section({ path: ['1. Intro'], title: '1. Intro', startBlock: 0, endBlock: 6 }),
  ],
  figures: [
    { id: 'f1', caption: 'Figure 1: the setup.', captionBlockId: 'b1' } as Figure,
    {
      id: 'f2',
      caption: 'Figure 1: the setup, again.',
      captionBlockId: 'b3',
    } as Figure,
  ],
  tables: [],
  theorems: [
    {
      kind: 'theorem',
      label: 'Theorem 3',
      statement: 'First result.',
      statementBlockId: 'b4',
    },
    {
      kind: 'theorem',
      label: 'Theorem 1',
      statement: 'Second result.',
      statementBlockId: 'b4',
    },
    { kind: 'lemma', label: 'Lemma 1', statement: 'Bound.', statementBlockId: 'b5' },
  ] as TheoremEnvironment[],
});

const numDoc = new Document({
  title: 'Numbers Paper',
  blocks: [
    B('b0', BlockType.TITLE, 'Numbers Paper'),
    B(
      'b0a',
      BlockType.ABSTRACT,
      'Abstract. Our mean absolute error is 3.42 and the pooled coverage is 91.5%.',
      ['Abstract'],
    ),
    B('b1', BlockType.HEADING, '1. Results', ['1. Results']),
    B(
      'b2',
      BlockType.PARAGRAPH,
      'The reported mean absolute error of 4.10 dominates the baseline, and ' +
        'the coverage reached 87.5% in the same run.',
      ['1. Results'],
    ),
    B(
      'b3',
      BlockType.PARAGRAPH,
      'Exclusions: the year 2019 matters, DOI 10.5555/12345678 exists, ' +
        'LaTeX $\\alpha$ appears with 1.5 spacing, and 7 plain integers like 42 ' +
        'are skipped. A value of 3.14 is generic.',
      ['1. Results'],
    ),
  ],
  sections: [
    new Section({ path: ['Abstract'], title: 'Abstract', startBlock: 0, endBlock: 2 }),
    new Section({
      path: ['1. Results'],
      title: '1. Results',
      startBlock: 2,
      endBlock: 5,
    }),
  ],
});

const internalDoc = new Document({
  title: 'Internal',
  blocks: [
    B('b0', BlockType.TITLE, 'Internal'),
    B(
      'b1',
      BlockType.ABSTRACT,
      'Abstract. The estimated treatment effect of 0.32 is robust, yet the ' +
        'estimated treatment effect reaches 0.58 under reweighting.',
      ['Abstract'],
    ),
  ],
});

const GOOD_TABLE =
  '| Region | Sales | Total |\n' +
  '| --- | ---: | ---: |\n' +
  '| North | 10.5 | 15.0 |\n' +
  '| South | 4.5 | 15.0 |\n' +
  '| Total | 15.0 | 30.0 |\n';
const BAD_TABLE =
  '| Region | Sales | Share | Total |\n' +
  '| --- | ---: | ---: | ---: |\n' +
  '| North | (1,200.5) | 55% | 17.0 |\n' +
  '| South | −3.5 | 45% | 4.0 |\n' +
  '| Total | 1,197.0 | 100% | 25.0 |\n';
const tableDoc = new Document({
  title: 'Tables Paper',
  blocks: [
    B('b0', BlockType.TITLE, 'Tables Paper'),
    B('b1', BlockType.HEADING, '1. Data', ['1. Data']),
    B('b2', BlockType.TABLE, GOOD_TABLE, ['1. Data']),
    B('b3', BlockType.TABLE, BAD_TABLE, ['1. Data']),
  ],
  tables: [
    {
      id: 'tbl_doc_01',
      caption: 'Table 1: main results.',
      markdown: GOOD_TABLE,
      captionBlockId: 'b1',
    } as TableArtifact,
  ],
});

const SEP_TABLE = '| A | B |\n| --- | ---: |\n| 1.0 | 2.0 |\n';
const sepDoc = new Document({
  title: 'Sep',
  blocks: [B('b0', BlockType.TABLE, SEP_TABLE)],
  tables: [{ id: 'tbl_sep', markdown: SEP_TABLE } as TableArtifact],
});

const toJs = (fs: ReturnType<typeof crossReferenceCheck>) =>
  fs.map((f) => ({
    check: f.check,
    title: f.title,
    message: f.message,
    quote: f.quote ?? '',
    section: f.section ?? null,
    category: f.category ?? 'consistency',
    severity: f.severity ?? 0.5,
    meta: f.meta ?? {},
    provenance: 'deterministic',
  }));

let failures = 0;
const cmp = (name: string, py: unknown, ts: unknown) => {
  const a = JSON.stringify(py);
  const b = JSON.stringify(ts);
  if (a !== b) {
    failures++;
    console.log(`MISMATCH ${name}\n  py: ${a}\n  ts: ${b}`);
  } else {
    console.log(`ok ${name} (${Array.isArray(py) ? py.length : 'scalar'})`);
  }
};

cmp('xref', expected.xref, toJs(crossReferenceCheck(xrefDoc)));
cmp('consistency', expected.consistency, toJs(numberConsistencyCheck(numDoc)));
cmp(
  'consistency_internal',
  expected.consistency_internal,
  toJs(numberConsistencyCheck(internalDoc)),
);
cmp('tables', expected.tables, toJs(tableArithmeticCheck(tableDoc)));
cmp('sep', expected.sep, toJs(tableArithmeticCheck(sepDoc)));
cmp('all', expected.all, toJs(runDeterministicChecks(xrefDoc)));

// %g formatter + decimals-of-.6f probes
const gf: Record<string, string> = {};
for (const k of Object.keys(expected.g_format as Record<string, string>)) {
  gf[k] = gFormat(Number(k));
}
cmp('g_format', expected.g_format, gf);

// regex probes (Python re vs JS) on shared inputs
const NUM_RE =
  /(?<![0-9A-Za-z.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)(?![0-9])\s?(%|pp\b|percentage points|per cent\b)?/gi;
const LABEL_DEF_RE =
  /^(figure|table|theorem|lemma|proposition|corollary|definition|algorithm|appendix)\s+([0-9]+[A-Z]?|[A-Z])(?![0-9A-Za-z])/i;
const LABEL_REF_RE =
  /\b(figure|fig\.|table|theorem|thm\.|lemma|proposition|prop\.|corollary|definition|algorithm)\s*~?\s*([0-9]+[A-Z]?)\b|\b(appendix)\s*~?\s+([A-Z])(?![a-z])/gi;
const EQ_REF_RE = /\b(?:equation|eq\.?s?|expression)\s*?\(?([0-9]+[a-z]?)\)?/gi;
const SECTION_REF_RE = /\b(?:section|sect\.?)\s+([0-9]+(?:\.[0-9]+)*)\b/gi;
const ANY_NUMBERED_LINE_RE = /^\s*\d{1,2}(?:\.\d{1,2}){0,2}[.:]?\s+[A-Z]\S.*$/;

const NUM_SAMPLES = [
  'grew 3.42% in 2019, by 1,234,567 units',
  'value7.5 and 7.5x and v7.5',
  '7.5 pp and 7.5percentage points and 5 per cent',
  'cost 12. (end) 3.5.2 and 91.5%',
  'in 2020 the rate hit 8.25per cent',
  'ratio 1.5e-3 and 007 and 0.5',
];
const LABEL_SAMPLES = [
  'Figure 1: setup',
  'figure 12a shows',
  'Theorem B. proof',
  'Table 3, results',
  'Definition 1.1 nested',
  'Appendix A. tables',
  'Figure 1plots',
  'Algorithm 2X:',
];
const REF_SAMPLES = [
  'see Figure 2 and Fig. 3',
  'by Theorem~4 done',
  'in Appendix~B now',
  'thm. 2 and prop. 5x',
  'Algorithm 2 handles Appendix C',
  'Figure 12ab',
  'appendix a low',
];
const EQ_SAMPLES = [
  'Eq. 3a holds',
  'equation (12) fails',
  'expression 4 fits',
  'eqs. 2-3',
  'equation 7x tests',
];
const SEC_SAMPLES = [
  'in Section 3.2.1 we',
  'see sect. 4.',
  'Section 12 done',
  'section 3a fails',
];
const LINE_SAMPLES = [
  '3.2 Methods used',
  '  12. Appendix stuff',
  '2: Notation',
  '3.2.1.1 too deep',
  '123 too long number',
  '3.2 lowercase start',
];

const findalls = (re: RegExp, samples: string[], whole = false) =>
  samples.map((s) =>
    [
      ...s.matchAll(
        new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
      ),
    ].map((m) => (whole ? [m[0]] : m.slice(1).map((g) => g ?? ''))),
  );
const spans = (re: RegExp, samples: string[]) =>
  samples.map((s) =>
    [
      ...s.matchAll(
        new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
      ),
    ].map((m) => [m.index!, m.index! + m[0].length]),
  );

const probes = expected.regex_probes;
cmp('num_re', probes.num_re, findalls(NUM_RE, NUM_SAMPLES));
cmp('num_re_spans', probes.num_re_spans, spans(NUM_RE, NUM_SAMPLES));
cmp('label_def_re', probes.label_def_re, findalls(LABEL_DEF_RE, LABEL_SAMPLES));
cmp(
  'label_def_re_spans',
  probes.label_def_re_spans,
  spans(LABEL_DEF_RE, LABEL_SAMPLES),
);
cmp('label_ref_re', probes.label_ref_re, findalls(LABEL_REF_RE, REF_SAMPLES));
cmp('label_ref_re_spans', probes.label_ref_re_spans, spans(LABEL_REF_RE, REF_SAMPLES));
cmp(
  'eq_ref_re',
  probes.eq_ref_re,
  findalls(EQ_REF_RE, EQ_SAMPLES, true)
    .map((xs: string[][]) => xs.map((x) => x[0]!.trim()))
    .map((xs: string[]) => xs.map((x) => x.replace(/.*\s/g, '').replace(/[()]/g, ''))),
);
cmp('eq_ref_re_spans', probes.eq_ref_re_spans, spans(EQ_REF_RE, EQ_SAMPLES));
cmp(
  'section_ref_re',
  probes.section_ref_re,
  findalls(SECTION_REF_RE, SEC_SAMPLES, true).map((xs: string[][]) =>
    xs.map((x) => x[0]!.replace(/.*\s/g, '')),
  ),
);
cmp(
  'section_ref_re_spans',
  probes.section_ref_re_spans,
  spans(SECTION_REF_RE, SEC_SAMPLES),
);
cmp(
  'any_numbered_line_re',
  probes.any_numbered_line_re,
  findalls(ANY_NUMBERED_LINE_RE, LINE_SAMPLES, true).map((xs: string[][]) =>
    xs.map((x) => x[0]!),
  ),
);
cmp(
  'any_numbered_line_re_spans',
  probes.any_numbered_line_re_spans,
  spans(ANY_NUMBERED_LINE_RE, LINE_SAMPLES),
);

console.log(failures === 0 ? 'ALL PARITY CHECKS GREEN' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
