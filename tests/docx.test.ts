import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../src/ingestion/document';
import { documentFromDocx } from '../src/ingestion/docx';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'minimal.docx');

describe('documentFromDocx (mammoth)', () => {
  it('ingests the minimal fixture: H1 title + body paragraph', async () => {
    const buf = readFileSync(FIXTURE);
    const doc = await documentFromDocx(buf, 'minimal');
    expect(doc.sourceFormat).toBe('docx');
    expect(doc.title).toBe('On the Stability of Widget Networks');
    const types = doc.blocks.map((b) => b.type);
    // Heading1 without a styles.xml definition still converts via mammoth's
    // default style map -> `# ...` ATX heading -> TITLE block.
    expect(types).toContain(BlockType.TITLE);
    expect(types).toContain(BlockType.PARAGRAPH);
    expect(doc.fullText()).toContain('Every widget network is stable');
  });

  it('accepts a plain ArrayBuffer', async () => {
    const buf = readFileSync(FIXTURE);
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
    const doc = await documentFromDocx(ab, 'minimal');
    expect(doc.title).toBe('On the Stability of Widget Networks');
  });

  it('rejects non-docx bytes with an error (no silent empty document)', async () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    await expect(documentFromDocx(junk, 'junk')).rejects.toThrow();
  });
});
