/**
 * DOCX format reader.
 *
 * Port of Python `open_referee/ingestion/readers.py::_ingest_docx`: mammoth
 * `convert_to_markdown` -> `documentFromMarkdown(md, 'docx', stem)`.
 *
 * mammoth is dynamic-imported so it stays out of the main browser bundle.
 * We import the browser build (`mammoth/mammoth.browser`) explicitly: it is
 * environment-agnostic (works in Node and the browser) and takes the
 * `{ arrayBuffer }` input form — the browser path has no `path`/`buffer`
 * input support. `convertToMarkdown` is mammoth's markdown output mode of
 * `convert` (heading-marked markdown via the default style map), matching
 * what the Python `mammoth.convert_to_markdown` produces.
 */

import type { Document as RefereeDocument } from './document';
import { documentFromMarkdown } from './readers_md';

/** Slice a possibly-shared ArrayBuffer view into a standalone ArrayBuffer. */
function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof Uint8Array) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  return data;
}

/**
 * Python `_ingest_docx`: convert the .docx bytes to markdown via mammoth and
 * run the shared markdown document builder with source_format="docx".
 */
export async function documentFromDocx(
  data: ArrayBuffer | Uint8Array,
  titleHint = '',
): Promise<RefereeDocument> {
  const { default: mammoth } = await import('mammoth/mammoth.browser.js');
  const { value } = await mammoth.convertToMarkdown({
    arrayBuffer: toArrayBuffer(data),
  });
  return documentFromMarkdown(value, 'docx', titleHint);
}
