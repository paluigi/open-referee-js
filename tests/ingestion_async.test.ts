import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UnsupportedFormatError,
  ingestByExtensionAsync,
} from '../src/ingestion/readers_md';

const DOCX_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'minimal.docx');
const PDF_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'minimal.pdf');

function bytes(p: string): ArrayBuffer {
  const buf = readFileSync(p);
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

describe('ingestByExtensionAsync', () => {
  it('markdown stays on the sync path (text accessor)', async () => {
    const doc = await ingestByExtensionAsync(
      '.md',
      () => '# Title\n\nBody.',
      () => new ArrayBuffer(0),
      'paper',
    );
    expect(doc.title).toBe('Title');
    expect(doc.sourceFormat).toBe('md');
  });

  it('routes .pdf to the pdfjs reader', async () => {
    const doc = await ingestByExtensionAsync(
      '.pdf',
      () => '',
      () => bytes(PDF_FIXTURE),
      'minimal',
    );
    expect(doc.sourceFormat).toBe('pdf');
    expect(doc.fullText()).toContain('3. Main result');
  });

  it('routes .docx to the mammoth reader', async () => {
    const doc = await ingestByExtensionAsync(
      '.docx',
      () => '',
      () => bytes(DOCX_FIXTURE),
      'minimal',
    );
    expect(doc.sourceFormat).toBe('docx');
    expect(doc.title).toBe('On the Stability of Widget Networks');
  });

  it('rejects .tex with the documented divergence message', async () => {
    await expect(
      ingestByExtensionAsync(
        '.tex',
        () => '',
        () => new ArrayBuffer(0),
      ),
    ).rejects.toThrow(UnsupportedFormatError);
    await expect(
      ingestByExtensionAsync(
        '.tex',
        () => '',
        () => new ArrayBuffer(0),
      ),
    ).rejects.toThrow(
      '.tex not supported in the browser build (no pylatexenc equivalent); convert to .md first',
    );
  });

  it('rejects unknown extensions like the sync path', async () => {
    await expect(
      ingestByExtensionAsync(
        '.doc',
        () => '',
        () => new ArrayBuffer(0),
      ),
    ).rejects.toThrow(UnsupportedFormatError);
  });
});
