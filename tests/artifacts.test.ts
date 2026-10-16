import { describe, expect, it } from 'vitest';
import { Block, BlockType, Document } from '../src/ingestion/document';
import {
  buildDefinitionsPack,
  extractTables,
  extractTheorems,
} from '../src/ingestion/artifacts';
import { documentFromMarkdown } from '../src/ingestion/readers_md';

/** Block factory mirroring the b00000-style ids the readers emit. */
function docFromBlocks(
  items: { text: string; type?: BlockType; sectionPath?: string[] }[],
): Document {
  const blocks = items.map(
    (it, i) =>
      new Block({
        id: `b${String(i).padStart(5, '0')}`,
        type: it.type,
        text: it.text,
        sectionPath: it.sectionPath ?? [],
        order: i,
      }),
  );
  return new Document({ title: 'T', sourceFormat: 'md', blocks });
}

describe('extractTheorems', () => {
  it('pairs a theorem statement with its proof, stopping at QED', () => {
    const doc = docFromBlocks([
      { text: 'Theorem 1. Every widget is stable.' },
      { text: 'Proof. Consider the Lyapunov function V.' },
      { text: 'This yields V(x) <= 0 for all x, which proves the claim. Q.E.D.' },
      { text: 'Some trailing remark.' },
    ]);
    const envs = extractTheorems(doc);
    expect(envs).toHaveLength(1);
    expect(envs[0]!.kind).toBe('theorem');
    expect(envs[0]!.label).toBe('Theorem 1');
    expect(envs[0]!.statement).toBe('Theorem 1. Every widget is stable.');
    expect(envs[0]!.proof).toContain('Proof.');
    expect(envs[0]!.proof).toContain('Q.E.D.');
    expect(envs[0]!.proof).not.toContain('trailing remark');
    expect(envs[0]!.statementBlockId).toBe('b00000');
    expect(envs[0]!.proofBlockId).toBe('b00001');
  });

  it('keeps a theorem without a proof', () => {
    const doc = docFromBlocks([
      { text: 'Lemma 2.3. Widgets converge.' },
      { text: 'A plain paragraph after.' },
    ]);
    const envs = extractTheorems(doc);
    expect(envs).toHaveLength(1);
    expect(envs[0]!.kind).toBe('lemma');
    expect(envs[0]!.label).toBe('Lemma 2.3');
    expect(envs[0]!.proof).toBeUndefined();
  });

  it('absorbs continuation paragraphs into the statement until Proof/new theorem/heading', () => {
    const doc = docFromBlocks([
      { text: 'Proposition 4. The map is continuous.' },
      { text: 'Continuation of the statement with more detail.' },
      { text: 'Proof.' },
      { text: 'Straightforward.' },
      { text: 'Theorem 5. Another one.' },
    ]);
    const envs = extractTheorems(doc);
    expect(envs).toHaveLength(2);
    expect(envs[0]!.statement).toContain('Continuation of the statement');
    expect(envs[0]!.proof).toBe('Proof.\n\nStraightforward.');
    expect(envs[1]!.kind).toBe('theorem');
    // the next theorem was consumed as a new environment, not proof body
    expect(envs[1]!.statement).toBe('Theorem 5. Another one.');
  });

  it('handles adjacent theorems and recognizes Definition/Assumption kinds', () => {
    const doc = docFromBlocks([
      { text: 'Definition 1. A widget graph is connected if... ' },
      { text: 'Theorem 2. Connected widgets are stable.' },
    ]);
    const envs = extractTheorems(doc);
    expect(envs).toHaveLength(2);
    expect(envs[0]!.kind).toBe('definition');
    expect(envs[1]!.kind).toBe('theorem');
  });

  it('a heading block stops statement absorption', () => {
    const doc = docFromBlocks([
      { text: 'Theorem 1. Statement.' },
      { text: '3. Next section', type: BlockType.HEADING },
      { text: 'Body text.' },
    ]);
    const envs = extractTheorems(doc);
    expect(envs).toHaveLength(1);
    expect(envs[0]!.statement).toBe('Theorem 1. Statement.');
  });

  it('returns empty for a doc with no theorems', () => {
    const doc = docFromBlocks([{ text: 'Plain paragraph.' }]);
    expect(extractTheorems(doc)).toEqual([]);
  });
});

describe('extractTables', () => {
  it('converts pipe-table blocks to TableArtifacts with sequential ids', () => {
    const doc = documentFromMarkdown(
      '# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |',
      'md',
      't',
    );
    const tables = extractTables(doc);
    expect(tables).toHaveLength(2);
    expect(tables[0]!.id).toBe('tbl_md_01');
    expect(tables[1]!.id).toBe('tbl_md_02');
    expect(tables[0]!.markdown).toContain('| a | b |');
    expect(tables[0]!.captionBlockId).toBe('b00001');
  });

  it('finds a Table caption within the ±2 window', () => {
    const doc = docFromBlocks([
      { text: 'Context paragraph.' },
      { text: 'Table 1: Simulation outcomes.' },
      { text: '| a | b |\n| --- | --- |\n| 1 | 2 |', type: BlockType.TABLE },
      { text: 'After.' },
    ]);
    const tables = extractTables(doc);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.caption).toBe('Table 1: Simulation outcomes.');
  });

  it('returns empty when there are no table blocks', () => {
    const doc = docFromBlocks([{ text: 'no tables here' }]);
    expect(extractTables(doc)).toEqual([]);
  });
});

describe('buildDefinitionsPack', () => {
  it('matches prose definitions sharing >=2 symbols with the theorem body', () => {
    // b0 follows the theorem at the END, so extractTheorems absorbs it into
    // the statement (it is not a Proof/new theorem/heading) — exercising the
    // statement side of the body used for symbol collection.
    const doc = docFromBlocks([
      { text: 'Theorem 1. The widget graph G is stable.' },
      { text: 'Let x = (V, E) be a widget graph.' },
      { text: 'A widget graph G is stable when V is bounded.' },
    ]);
    const [env] = extractTheorems(doc);
    const pack = buildDefinitionsPack(doc, env!);
    // The prose definition line matches DEF_RE and shares G, V with the body.
    expect(pack).toContain('[b00002]');
  });

  it('includes definition-environment theorems (same section or symbol overlap)', () => {
    const doc = docFromBlocks([
      {
        text: 'Definition 2.1. A graph G is stable if every node of G has degree >= 2.',
        sectionPath: ['2. Model'],
      },
      { text: 'Theorem 2. The graph G is stable.', sectionPath: ['2. Model'] },
    ]);
    doc.theorems = extractTheorems(doc);
    const env = doc.theorems.find((e) => e.kind === 'theorem')!;
    const pack = buildDefinitionsPack(doc, env);
    expect(pack).toContain('[Definition 2.1]');
  });

  it('returns the fallback string when nothing matches', () => {
    const doc = docFromBlocks([
      { text: 'Unrelated prose without definitions.' },
      { text: 'Theorem 9. Zeta omega kappa.' },
    ]);
    const [env] = extractTheorems(doc);
    expect(buildDefinitionsPack(doc, env!)).toBe('(no definitions matched)');
  });
});

describe('extractTables + extractTheorems on markdown doc (integration)', () => {
  it('works end-to-end on a markdown paper', () => {
    const md = `# Widgets

## 3. Main result

Theorem 1. Every widget is stable.

Proof. Obvious. Q.E.D.

| a | b |
| --- | --- |
| 1 | 2 |
`;
    const doc = documentFromMarkdown(md, 'md', 'paper');
    expect(extractTheorems(doc)).toHaveLength(1);
    expect(extractTables(doc)).toHaveLength(1);
  });
});
