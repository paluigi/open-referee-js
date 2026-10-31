import { describe, expect, it } from 'vitest';
import { Block, BlockType, Document, Section } from '../src/ingestion/document';
import type {
  Figure,
  TableArtifact,
  TheoremEnvironment,
} from '../src/ingestion/document';
import {
  crossReferenceCheck,
  findingToDict,
  numberConsistencyCheck,
  runDeterministicChecks,
  tableArithmeticCheck,
  gFormat,
  parseMdTable,
  num,
  consistent,
} from '../src/pipeline/checkers';

// ===== Python-generated expected values (`uv run python` in the open-referee
// repo at origin/main 26ae883 against pipeline/checkers.py; PY_* pattern from
// tests/bibliography.test.ts). Fixture documents are built with the SAME
// block/section/figure/table/theorem data on both sides (scripts/checkers_
// parity_probe.ts runs this comparison wholesale in CI dev environments).

const B = (id: string, type: BlockType, text: string, sectionPath: string[] = []) =>
  new Block({ id, type, text, sectionPath, order: 0 });

/** Python CheckFinding.to_dict() shape for one TS finding. */
const toDict = (f: ReturnType<typeof crossReferenceCheck>[number]) => findingToDict(f);

// ------------------------------------------------------- xref fixture doc --

const xrefDoc = () =>
  new Document({
    title: 'Parity Paper',
    blocks: [
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
    ],
    sections: [
      new Section({
        path: ['1. Intro'],
        title: '1. Intro',
        startBlock: 0,
        endBlock: 6,
      }),
    ],
    figures: [
      { id: 'f1', caption: 'Figure 1: the setup.', captionBlockId: 'b1' } as Figure,
      {
        id: 'f2',
        caption: 'Figure 1: the setup, again.',
        captionBlockId: 'b3',
      } as Figure,
    ],
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

// PY_XREF: python -c "(pin of cross_reference_check on the fixture above)"
const PY_XREF: Record<string, unknown>[] = [
  {
    check: 'xref',
    title: 'Duplicate label Theorem 3',
    message:
      'Theorem 3 is defined more than once; references to it are ambiguous. ' +
      'This usually means a renumbering after edits missed a copy.',
    quote:
      'Theorem 3. First result.\n\nTheorem 1. Second result.\n\nTheorem 2. Third result.',
    section: null,
    category: 'reference',
    severity: 0.45,
    meta: { class: 'Theorem', label: '3', kind: 'duplicate' },
    provenance: 'deterministic',
  },
  {
    check: 'xref',
    title: 'Duplicate label Figure 1',
    message:
      'Figure 1 is defined more than once; references to it are ambiguous. ' +
      'This usually means a renumbering after edits missed a copy.',
    quote: 'Figure 1: the setup, again.',
    section: null,
    category: 'reference',
    severity: 0.45,
    meta: { class: 'Figure', label: '1', kind: 'duplicate' },
    provenance: 'deterministic',
  },
  {
    check: 'xref',
    title: 'Reference to undefined Figure 9',
    message:
      'The text refers to Figure 9, but no Figure with that number is defined ' +
      'anywhere in the document.',
    quote:
      'Figure 1: the setup. See Section 4 for details. Also Figure 9 plots the ' +
      'residual diagnostic and Section 5.2 expands the argument.',
    section: '1. Intro',
    category: 'reference',
    severity: 0.35,
    meta: { class: 'Figure', label: '9', kind: 'dangling', occurrences: 1 },
    provenance: 'deterministic',
  },
  {
    check: 'xref',
    title: 'Reference to undefined Theorem 2',
    message:
      'The text refers to Theorem 2, but no Theorem with that number is defined ' +
      'anywhere in the document.',
    quote:
      'Theorem 3. First result.\n\nTheorem 1. Second result.\n\nTheorem 2. Third result.',
    section: '1. Intro',
    category: 'reference',
    severity: 0.35,
    meta: { class: 'Theorem', label: '2', kind: 'dangling', occurrences: 1 },
    provenance: 'deterministic',
  },
  {
    check: 'xref',
    title: 'Reference to undefined Theorem 4',
    message:
      'The text refers to Theorem 4, but no Theorem with that number is defined ' +
      'anywhere in the document.',
    quote: 'By Theorem 4 the claim follows, and Lemma 1 gives the bound used later.',
    section: '1. Intro',
    category: 'reference',
    severity: 0.35,
    meta: { class: 'Theorem', label: '4', kind: 'dangling', occurrences: 1 },
    provenance: 'deterministic',
  },
  {
    check: 'xref',
    title: 'References to sections without matching headings',
    message:
      'The text cites section numbers that do not match any section heading or ' +
      'numbered block: 4, 5.2. Check whether a renumbering or a formatting loss ' +
      'in conversion broke the internal structure.',
    quote:
      'Figure 1: the setup. See Section 4 for details. Also Figure 9 plots the ' +
      'residual diagnostic and Section 5.2 expands the argument.',
    section: '1. Intro',
    category: 'reference',
    severity: 0.35,
    meta: { kind: 'section-refs', missing: { '4': 1, '5.2': 1 } },
    provenance: 'deterministic',
  },
];

describe('crossReferenceCheck (parity: py pipeline/checkers.py)', () => {
  it('matches Python to_dict output on the xref fixture (6 findings)', () => {
    expect(xrefDoc().blocks.length).toBe(6); // fixture shape guard
    expect(crossReferenceCheck(xrefDoc()).map(toDict)).toEqual(PY_XREF);
  });

  it('dangling refs aggregate per (class,label) with sorted order', () => {
    const doc = new Document({
      title: 'Agg',
      blocks: [
        B('b0', BlockType.TITLE, 'Agg'),
        B('b1', BlockType.HEADING, '1. X', ['1. X']),
        B(
          'b2',
          BlockType.PARAGRAPH,
          'Theorem 9 holds here. Later Theorem 9 again, and Theorem 8 too.',
          ['1. X'],
        ),
        B(
          'b3',
          BlockType.PARAGRAPH,
          'Theorem 2. Defined out of order after Theorem 1 and Theorem 3 exist.\n\n' +
            'Theorem 1. One.\n\nTheorem 3. Three.',
          ['1. X'],
        ),
      ],
    });
    const findings = crossReferenceCheck(doc).map(toDict);
    // Definitions: prose-embedded Theorem 1/3 in b3's FIRST line ("Theorem 2.")
    // plus the b3 "Theorem 1."/"Theorem 3." lines count as definitions too —
    // so "Theorem 1"/"Theorem 3" have definitions while 8/9 dangle.
    // Wait: b2 references Theorem 1/3 -> defined; Python pins (verified via
    // uv-run): Theorem 1 (2×), Theorem 3 (2×) are dangling TOO — b3's
    // multi-line text only defines from its first 3 LINES: line 0 is
    // "Theorem 2. Defined..." (punct -> definition, then break), lines 1-2
    // ("Theorem 1. One." / "Theorem 3. Three.") never get scanned because of
    // the break. So only Theorem 2 is defined; 1/3/8/9 all dangle.
    const dangling = findings.filter(
      (f) => (f.meta as { kind?: string }).kind === 'dangling',
    );
    expect(dangling.map((f) => f.title)).toEqual([
      'Reference to undefined Theorem 1 (2×)',
      'Reference to undefined Theorem 3 (2×)',
      'Reference to undefined Theorem 8',
      'Reference to undefined Theorem 9 (2×)',
    ]);
    const agg9 = dangling.find((f) => (f.meta as { label?: string }).label === '9')!;
    expect((agg9.meta as { occurrences: number }).occurrences).toBe(2);
    expect(agg9.message).toContain('— 2 references in total');
    // duplicated class (Theorem 2 vs b2's prose "Theorem 9" no — duplicates
    // come only from definitions; here Theorem 2 is the sole definition, so
    // no duplicate and no ordering finding: 1 number < 3 minimum.
    expect(
      findings.some((f) => (f.meta as { kind?: string }).kind === 'ordering'),
    ).toBe(false);
  });

  it('ordering finding fires on 3+ defined labels out of order (Python list-repr message)', () => {
    const doc = new Document({
      title: 'Mono',
      blocks: [
        B('b0', BlockType.TITLE, 'Mono'),
        B('b1', BlockType.HEADING, '1. X', ['1. X']),
        B('b2', BlockType.PARAGRAPH, 'Theorem 3. A.', ['1. X']),
        B('b3', BlockType.PARAGRAPH, 'Theorem 1. B.', ['1. X']),
        B('b4', BlockType.PARAGRAPH, 'Theorem 2. C.', ['1. X']),
      ],
    });
    const findings = crossReferenceCheck(doc).map(toDict);
    const ordering = findings.find(
      (f) => (f.meta as { kind?: string }).kind === 'ordering',
    )!;
    expect(ordering).toBeDefined();
    expect((ordering.meta as { sequence: number[] }).sequence).toEqual([3, 1, 2]);
    expect(ordering.title).toBe('Theorem numbering is not monotone');
    expect(ordering.message).toBe(
      'Theorem numbers appear out of order in the document ([3, 1, 2]); check for renumbering after edits.',
    );
    expect(ordering.severity).toBe(0.3);
  });

  it('orphan classes collapse to one low-severity note; Definition refs skipped', () => {
    const doc = new Document({
      title: 'Orphan',
      blocks: [
        B('b0', BlockType.TITLE, 'Orphan'),
        B('b1', BlockType.HEADING, '1. X', ['1. X']),
        B(
          'b2',
          BlockType.PARAGRAPH,
          'Table 2 shows data, Table 5 more, Definition 4 says nothing.',
          ['1. X'],
        ),
      ],
    });
    const findings = crossReferenceCheck(doc).map(toDict);
    const orphans = findings.filter(
      (f) => (f.meta as { kind?: string }).kind === 'orphan-class',
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.title).toBe('No table captions found for 2 reference(s)');
    expect(orphans[0]!.severity).toBe(0.2);
    // Definition is in _SKIP_CLASS_FOR_REFS: never a dangling finding
    expect(
      findings.some((f) => (f.meta as { class?: string }).class === 'Definition'),
    ).toBe(false);
  });

  it('prose-looking lines are not definitions; punctuation rules apply', () => {
    const doc = new Document({
      title: 'Defs',
      blocks: [
        B('b0', BlockType.TITLE, 'Defs'),
        B('b1', BlockType.HEADING, '1. X', ['1. X']),
        // "Figure 9 plots" — letter after the label -> NOT a definition
        B('b2', BlockType.PARAGRAPH, 'Figure 9 plots the data clearly and fully.', [
          '1. X',
        ]),
        // "Figure 9:" — punctuation -> definition
        B('b3', BlockType.CAPTION, 'Figure 9: actual caption', ['1. X']),
        // long paragraph (>=120) is prose even with a label-like start
        B(
          'b4',
          BlockType.PARAGRAPH,
          'Table 4 summarizes everything about the long estimation protocol used ' +
            'throughout the paper and its robustness checks, with all variants shown.',
          ['1. X'],
        ),
      ],
    });
    // Figure 9 IS defined (b3 caption) and b2 is a reference -> no dangling,
    // no orphan (class has definitions). b4's Table 4 mention: paragraph
    // starts with a label but is >=120 chars prose -> not a definition ->
    // "Table 4" ref with no Table defs -> orphan-class.
    const findings = crossReferenceCheck(doc).map(toDict);
    expect(
      findings.some((f) => (f.meta as { kind?: string }).kind === 'dangling'),
    ).toBe(false);
    expect(
      findings.filter((f) => (f.meta as { kind?: string }).kind === 'orphan-class'),
    ).toHaveLength(1);
  });

  it('caps findings at 8 (Python _MAX_XREF_FINDINGS)', () => {
    const blocks = [
      B('b0', BlockType.TITLE, 'Cap'),
      B('b1', BlockType.HEADING, '1. X', ['1. X']),
    ];
    // one defined Figure 1 then 10 dangling Figure refs
    let text = 'Figure 1 is defined. ';
    for (let i = 2; i <= 11; i++) text += `See Figure ${i}. `;
    blocks.push(B('b2', BlockType.PARAGRAPH, text, ['1. X']));
    blocks.push(B('b3', BlockType.CAPTION, 'Figure 1: the only one.', ['1. X']));
    const doc = new Document({ title: 'Cap', blocks });
    expect(crossReferenceCheck(doc).length).toBeLessThanOrEqual(8);
  });
});

// ------------------------------------------------- number consistency doc --

const numDoc = () =>
  new Document({
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
      new Section({
        path: ['Abstract'],
        title: 'Abstract',
        startBlock: 0,
        endBlock: 2,
      }),
      new Section({
        path: ['1. Results'],
        title: '1. Results',
        startBlock: 2,
        endBlock: 5,
      }),
    ],
  });

const PY_CONSISTENCY: Record<string, unknown>[] = [
  {
    check: 'consistency',
    title: 'Conflicting values for "absolute error is" (3.42 vs 4.10)',
    message:
      'The quantity described as "absolute error is" is reported as 3.42 in one ' +
      'place and 4.10 in another; at most one can be correct. Verify which value ' +
      'is right and align the others.',
    quote:
      '[abstract] …Abstract. Our mean absolute error is 3.42 and the pooled ' +
      'coverage is 91.5%.…\n\n[paragraph] …The reported mean absolute error of ' +
      '4.10 dominates the baseline, and the coverage reached 87.5% in the same run.…',
    section: null,
    category: 'consistency',
    severity: 0.7,
    meta: { template: 'absolute error is', values: ['3.42', '4.10'] },
    provenance: 'deterministic',
  },
];

describe('numberConsistencyCheck (parity: py pipeline/checkers.py)', () => {
  it('flags the abstract-vs-body conflict with the exact Python wording', () => {
    expect(numberConsistencyCheck(numDoc()).map(toDict)).toEqual(PY_CONSISTENCY);
  });

  it('tolerance boundaries (Python _consistent): 0.6*10^-minDec and 1% relative', () => {
    // 3.42 vs 3.44: |diff|=0.02 <= 0.6*0.01? no; 1% of 3.44=0.0344 -> consistent
    expect(consistent('3.42', '3.44')).toBe(true);
    // 3.42 vs 3.45: 1% rel bound 0.0345 -> 0.03 <= it -> consistent
    expect(consistent('3.42', '3.45')).toBe(true);
    // 2.50 vs 2.90: neither -> conflict
    expect(consistent('2.50', '2.90')).toBe(false);
    // 100 vs 100.9: 1% of 100.9 -> consistent
    expect(consistent('100', '100.9')).toBe(true);
  });

  it('dedupes by template+values (Python emits only the first conflict pair per template scan)', () => {
    const doc = new Document({
      title: 'Dup',
      blocks: [
        B('b0', BlockType.TITLE, 'Dup'),
        B(
          'b1',
          BlockType.ABSTRACT,
          'Abstract. Our mean absolute error is 3.42 in total. The mean absolute ' +
            'error reaches 4.10 under stress, and the error is large.',
          ['Abstract'],
        ),
        B('b2', BlockType.HEADING, '1. R', ['1. R']),
        B(
          'b3',
          BlockType.PARAGRAPH,
          'The mean absolute error hits 4.80 elsewhere, and mean absolute error ' +
            'of 5.20 too.',
          ['1. R'],
        ),
      ],
    });
    const findings = numberConsistencyCheck(doc).map(toDict);
    // Python pins (uv-run verified): only ONE finding — 4.10 is consistent
    // with... no: 3.42 vs 4.10 fails the 1% test. The single finding is
    // because "absolute error reaches"/"absolute error of"/"absolute error
    // hits" templates differ on their last two CONTENT words? No — 'reaches',
    // 'hits', 'of' are content/connector... Python output: exactly one
    // finding (3.42 vs 5.20) — 'error is' template comes from the abstract's
    // "error is large" tail; 4.10's "error reaches" and 4.80's "error hits"
    // are different quantity templates; 5.20's "error of" reduces to
    // (absolute, error) matching. Port matches Python exactly here.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe(
      'Conflicting values for "absolute error is" (3.42 vs 5.20)',
    );
  });

  it('no abstract -> front-matter proxy requires the SAME template in body', () => {
    // Python pins: "error is" (abstract) vs "error reaches" (body) are
    // different templates -> no finding; "reaches" replaced by "is" -> fires.
    const base = [
      B('b0', BlockType.TITLE, 'Front'),
      B('b1', BlockType.PARAGRAPH, 'Our mean absolute error is 2.50 throughout.'),
      B('b2', BlockType.PARAGRAPH, 'Second paragraph with no numbers of interest.'),
      B('b3', BlockType.HEADING, '1. Body', ['1. Body']),
    ];
    const noMatch = new Document({
      title: 'Front',
      blocks: [
        ...base,
        B('b4', BlockType.PARAGRAPH, 'The mean absolute error reaches 2.90 here.'),
      ],
    });
    expect(numberConsistencyCheck(noMatch)).toEqual([]);
    const match = new Document({
      title: 'Front',
      blocks: [
        ...base,
        B('b4', BlockType.PARAGRAPH, 'The mean absolute error is 2.90 here.'),
      ],
    });
    const findings = numberConsistencyCheck(match).map(toDict);
    expect(findings).toHaveLength(1);
    expect((findings[0]!.meta as { values: string[] }).values).toEqual([
      '2.50',
      '2.90',
    ]);
  });

  it('skips: plain integers, small unit-less, years, DOIs, LaTeX prefixes, generic/structural tails', () => {
    const doc = new Document({
      title: 'Skip',
      blocks: [
        B('b0', BlockType.TITLE, 'Skip'),
        B(
          'b1',
          BlockType.ABSTRACT,
          'Abstract. The year 2019 passed; DOI 10.5555/12345678 is a ref; ' +
            '$\\alpha$ equals 3.75 in math mode; a value of 2.50 is generic; ' +
            'section 4.2 references; 7 units are small integers; but our mean ' +
            'absolute error is 1.25.',
          ['Abstract'],
        ),
      ],
    });
    expect(numberConsistencyCheck(doc)).toEqual([]);
  });
});

// ------------------------------------------------------- table arithmetic --

const GOOD_TABLE =
  '| Region | Sales | Total |\n| --- | ---: | ---: |\n| North | 10.5 | 15.0 |\n| South | 4.5 | 15.0 |\n| Total | 15.0 | 30.0 |\n';
const BAD_TABLE =
  '| Region | Sales | Share | Total |\n' +
  '| --- | ---: | ---: | ---: |\n' +
  '| North | (1,200.5) | 55% | 17.0 |\n' +
  '| South | −3.5 | 45% | 4.0 |\n' +
  '| Total | 1,197.0 | 100% | 25.0 |\n';

const PY_TABLES: Record<string, unknown>[] = [
  {
    check: 'table-arithmetic',
    title: 'Total row does not sum: Sales (b3)',
    message:
      'The "Total" row reports 1197 for "Sales", but the rows above sum to ' +
      '-1204. Recomputed from the table itself.',
    quote: '| Region | Sales | Share | Total |',
    section: null,
    category: 'consistency',
    severity: 0.7,
    meta: { table: 'b3', column: 'Sales', reported: 1197, computed: -1204 },
    provenance: 'deterministic',
  },
  {
    check: 'table-arithmetic',
    title: 'Total row does not sum: Total (b3)',
    message:
      'The "Total" row reports 25 for "Total", but the rows above sum to 21. ' +
      'Recomputed from the table itself.',
    quote: '| Region | Sales | Share | Total |',
    section: null,
    category: 'consistency',
    severity: 0.7,
    meta: { table: 'b3', column: 'Total', reported: 25, computed: 21 },
    provenance: 'deterministic',
  },
];

describe('tableArithmeticCheck (parity: py pipeline/checkers.py)', () => {
  it('matches Python on paren-negatives, unicode minus, share exclusion', () => {
    const doc = new Document({
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
    expect(tableArithmeticCheck(doc).map(toDict)).toEqual(PY_TABLES);
  });

  it('parses separator rows (2+ dashes, colon-aligned) and skips <3 data rows', () => {
    // separator detected -> only 2 rows -> null
    expect(parseMdTable('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBeNull();
    // single-dash row is NOT a separator -> 3 rows parse
    expect(parseMdTable('| a | b |\n| - | - |\n| 1 | 2 |')).toEqual([
      ['a', 'b'],
      ['-', '-'],
      ['1', '2'],
    ]);
    expect(parseMdTable('| a | b |\n| :---: | ---: |\n| 1 | 2 |\n| 3 | 4 |')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('_num: paren-negative, comma, %, unicode minus; rejects scientific/plus/trailing-dot', () => {
    expect(num('(1,200.5)')).toBe(-1200.5);
    expect(num('−3.5')).toBe(-3.5);
    expect(num('55%')).toBe(55);
    expect(num('( 4 )')).toBe(-4);
    expect(num('n/a')).toBeNull();
    expect(num('1e5')).toBeNull();
    expect(num('+5')).toBeNull();
    expect(num('5.')).toBeNull();
    expect(num('.5')).toBeNull();
  });

  it('row-total mismatch on a total-named column; caption appended when present', () => {
    const md =
      '| Item | A | B | Total |\n' +
      '| --- | ---: | ---: | ---: |\n' +
      '| x | 1.0 | 2.0 | 3.5 |\n' +
      '| y | 2.0 | 3.0 | 5.0 |\n';
    const doc = new Document({
      title: 'Rows',
      blocks: [B('b0', BlockType.TABLE, md)],
      tables: [
        { id: 'tbl_row', markdown: md, caption: 'Table 2: rows.' } as TableArtifact,
      ],
    });
    const findings = tableArithmeticCheck(doc).map(toDict);
    // Python pins (uv-run verified): the table is counted TWICE — once as a
    // TableArtifact (tbl_row) and once as a type='table' block (b0). That is
    // Python's exact behavior (doc.tables + table blocks, no dedupe).
    expect(findings).toHaveLength(2);
    expect(findings[0]!.title).toBe('Row total mismatch in tbl_row: x');
    expect(findings[1]!.title).toBe('Row total mismatch in b0: x');
    expect(findings[0]!.message).toContain(
      "reports 3.5 but the row's other numeric columns sum to 3.",
    );
    expect(findings[0]!.message).toContain(' (Table 2: rows.)');
    expect(findings[1]!.message).not.toContain('(Table 2');
    // share columns are excluded from the part sum
    const mdShare =
      '| Item | A | Share | Total |\n' +
      '| --- | ---: | ---: | ---: |\n' +
      '| x | 1.0 | 50% | 1.0 |\n' +
      '| y | 2.0 | 50% | 2.0 |\n';
    const doc2 = new Document({
      title: 'Rows2',
      blocks: [B('b0', BlockType.TABLE, mdShare)],
    });
    // A=1.0 is the only part (Share excluded) -> len(parts)<2 -> no finding
    expect(tableArithmeticCheck(doc2)).toEqual([]);
  });

  it('tolerance: small rounding noise stays silent', () => {
    const md =
      '| Item | A | Total |\n| --- | ---: | ---: |\n| x | 1.0 | 1.0 |\n| y | 2.004 | 3.0 |\n';
    const doc = new Document({ title: 'Tol', blocks: [B('b0', BlockType.TABLE, md)] });
    // 1.0 + 2.004 = 3.004 vs total 3.0: tol = max(0.5*10^-3, 3*0.005) = 0.015
    expect(tableArithmeticCheck(doc)).toEqual([]);
  });
});

// ------------------------------------------------------------------- entry --

describe('runDeterministicChecks + formatting (parity: py)', () => {
  it('runs the three checks in Python order', () => {
    const findings = runDeterministicChecks(xrefDoc()).map(toDict);
    expect(findings).toEqual(PY_XREF);
    expect(findings.every((f) => f.provenance === 'deterministic')).toBe(true);
  });

  it('findingToDict adds provenance deterministic; recompute reserved', () => {
    expect(findingToDict({ check: 'xref', title: 't', message: 'm' }).provenance).toBe(
      'deterministic',
    );
    expect(
      findingToDict({ check: 'recompute', title: 't', message: 'm' }).provenance,
    ).toBe('recompute');
    expect(findingToDict({ check: 'xref', title: 't', message: 'm' })).toEqual({
      check: 'xref',
      title: 't',
      message: 'm',
      quote: '',
      section: null,
      category: 'consistency',
      severity: 0.5,
      meta: {},
      provenance: 'deterministic',
    });
  });

  it('gFormat equals Python f"{x:g}" on the pinned fixtures (incl. ties, sci notation)', () => {
    // pinned from `uv run python` (parity harness gen_expected/gen_extra)
    const cases: [number, string][] = [
      [1.0, '1'],
      [0.5, '0.5'],
      [1234.5678, '1234.57'],
      [1234567.0, '1.23457e+06'],
      [12345678.0, '1.23457e+07'],
      [0.000123456, '0.000123456'],
      [3.42, '3.42'],
      [15.0, '15'],
      [1197.0, '1197'],
      [1e-9, '1e-09'],
      [100000.0, '100000'],
      [123456.0, '123456'],
      [999999.0, '999999'],
      [1000000.0, '1e+06'],
      [0.0001, '0.0001'],
      [1e-5, '1e-05'],
      [-3.5, '-3.5'],
      [123456.5, '123456'], // Python round-half-even on the exact double
      [0.30000000000000004, '0.3'],
      [21.0, '21'],
      [-1204.0, '-1204'],
    ];
    for (const [v, expected] of cases) {
      expect(gFormat(v)).toBe(expected);
    }
  });
});
