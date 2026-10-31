/** Extra edge-case parity probe (dev-only). */
import { readFileSync } from 'node:fs';
import { Block, BlockType, Document, Figure } from '../src/ingestion/document';
import {
  crossReferenceCheck,
  gFormat,
  num,
  parseMdTable,
  consistent,
  runDeterministicChecks,
} from '../src/pipeline/checkers';

const expected = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
let failures = 0;
const cmp = (name: string, py: unknown, ts: unknown) => {
  const a = JSON.stringify(py);
  const b = JSON.stringify(ts);
  if (a !== b) {
    failures++;
    console.log(`MISMATCH ${name}\n  py: ${a}\n  ts: ${b}`);
  } else {
    console.log(`ok ${name}`);
  }
};

cmp(
  'g_extra',
  expected.g_extra,
  Object.fromEntries(Object.keys(expected.g_extra).map((k) => [k, gFormat(Number(k))])),
);

const B = (id: string, type: BlockType, text: string, sectionPath: string[] = []) =>
  new Block({ id, type, text, sectionPath, order: 0 });

const edgeDoc = new Document({
  title: 'Edge',
  blocks: [
    B('b0', BlockType.TITLE, 'Edge'),
    B('b1', BlockType.HEADING, '1. X', ['1. X']),
    B('b2', BlockType.PARAGRAPH, 'See Table 2 and Table 5 twice: Table 2 again.', [
      '1. X',
    ]),
    B('b3', BlockType.PARAGRAPH, 'By eq. 4 and equation 4 the identity holds.', [
      '1. X',
    ]),
    B('b4', BlockType.EQUATION, '$$x = y \\tag{4}$$', ['1. X']),
  ],
});
cmp('edge_xref', expected.edge_xref, crossReferenceCheck(edgeDoc).map(toDict));

const dupDoc = new Document({
  title: 'Dup',
  blocks: [B('b0', BlockType.TITLE, 'Dup')],
  figures: [
    { id: 'f1', caption: 'Fig. 1: alpha', captionBlockId: 'b0' } as Figure,
    { id: 'f2', caption: 'figure 1: beta', captionBlockId: 'b0' } as Figure,
  ],
});
cmp('dup_fig', expected.dup_fig, crossReferenceCheck(dupDoc).map(toDict));

const frontDoc = new Document({
  title: 'Front',
  blocks: [
    B('b0', BlockType.TITLE, 'Front'),
    B('b1', BlockType.PARAGRAPH, 'Our mean absolute error is 2.50 throughout.'),
    B('b2', BlockType.PARAGRAPH, 'Second paragraph with no numbers of interest.'),
    B('b3', BlockType.HEADING, '1. Body', ['1. Body']),
    B('b4', BlockType.PARAGRAPH, 'The mean absolute error reaches 2.90 here.'),
  ],
});
cmp('front', expected.front, runDeterministicChecks(frontDoc).map(toDict));

const tables = [
  '| a | b |\n| --- | --- |\n| 1 | 2 |',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '| a | b |\n| :---: | ---: |\n| 1 | 2 |\n| 3 | 4 |',
];
cmp('parse_md', expected.parse_md, tables.map(parseMdTable));
cmp(
  'num_cells',
  expected.num_cells,
  Object.fromEntries(Object.keys(expected.num_cells).map((k) => [k, num(k)])),
);

function toDict(f: ReturnType<typeof crossReferenceCheck>[number]) {
  return {
    check: f.check,
    title: f.title,
    message: f.message,
    quote: f.quote ?? '',
    section: f.section ?? null,
    category: f.category ?? 'consistency',
    severity: f.severity ?? 0.5,
    meta: f.meta ?? {},
    provenance: 'deterministic',
  };
}
export {};

// consistent + dec_total need the private helpers; use the exported surface.
// (consistent is exported below for the probe only.)
cmp('consistent', expected.consistent, {
  '3.42|3.44': consistent('3.42', '3.44'),
  '3.42|3.45': consistent('3.42', '3.45'),
  '3.4|3.44': consistent('3.4', '3.44'),
  '100|100.9': consistent('100', '100.9'),
  '100|101': consistent('100', '101'),
  '3.42|3.42': consistent('3.42', '3.42'),
  '2.50|2.90': consistent('2.50', '2.90'),
});
console.log(failures === 0 ? 'ALL EXTRA CHECKS GREEN' : `${failures} FAILURES`);
if (failures > 0) process.exit(1);
