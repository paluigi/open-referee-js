/** Mono fixture probe (dev-only): duplicate classes suppress the ordering check. */
import { readFileSync } from 'node:fs';
import { Block, BlockType, Document, Figure } from '../src/ingestion/document';
import type { TheoremEnvironment } from '../src/ingestion/document';
import { crossReferenceCheck } from '../src/pipeline/checkers';

const expected = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const B = (id: string, type: BlockType, text: string, sectionPath: string[] = []) =>
  new Block({ id, type, text, sectionPath, order: 0 });
const doc = new Document({
  title: 'Mono',
  blocks: [
    B('b0', BlockType.TITLE, 'Mono'),
    B('b1', BlockType.HEADING, '1. X', ['1. X']),
    B('b2', BlockType.PARAGRAPH, 'Theorem 3. A.\n\nTheorem 1. B.\n\nTheorem 2. C.', [
      '1. X',
    ]),
    B(
      'b3',
      BlockType.PARAGRAPH,
      'Figure 2 plots it, and Figure 2 is duplicated below.',
      ['1. X'],
    ),
  ],
  figures: [
    { id: 'f1', caption: 'Figure 2: one', captionBlockId: 'b1' } as Figure,
    { id: 'f2', caption: 'Figure 2: two', captionBlockId: 'b3' } as Figure,
  ],
  theorems: [
    { kind: 'theorem', label: 'Theorem 3', statement: 'A.', statementBlockId: 'b2' },
    { kind: 'theorem', label: 'Theorem 1', statement: 'B.', statementBlockId: 'b2' },
    { kind: 'theorem', label: 'Theorem 2', statement: 'C.', statementBlockId: 'b2' },
  ] as TheoremEnvironment[],
});
const ts = crossReferenceCheck(doc).map((f) => ({
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
const ok = JSON.stringify(expected) === JSON.stringify(ts);
console.log(
  ok
    ? 'MONO GREEN'
    : `MISMATCH\n py: ${JSON.stringify(expected)}\n ts: ${JSON.stringify(ts)}`,
);
process.exit(ok ? 0 : 1);
