/**
 * Markdown format reader.
 *
 * Port of the markdown path of Python `open_referee/ingestion/readers.py`
 * (`document_from_markdown` / `_ingest_markdown`). The regexes are ported
 * exactly — they encode the semantics of heading / abstract / equation /
 * reference detection. PDF/DOCX/LaTeX readers arrive in Stage 3.
 */

import { Block, BlockType, Document, Section } from './document';

/** `# Heading` (ATX, 1-6 hashes). */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** Numbered section line like `3. Main result` or `Appendix A Title`. */
const NUMBERED_HEADING_RE =
  /^(?:(\d+(?:\.\d+)*)\.?|Appendix\s+([A-Z]))\s+([A-Z][^\n]{2,120})$/;
/** Leading `abstract` (optionally starred, `:` or `.`). */
const ABSTRACT_RE = /^\*{0,2}abstract\*{0,2}[:.]?\s*/i;
/** Display math `$$...$$` (single paragraph). */
const EQ_RE = /^\$\$(.+)\$\$$/s;
/** A bare `References` / `Bibliography` line (optionally starred). */
const REF_RE = /^\*{0,2}(references|bibliography)\*{0,2}[:.]?\s*$/i;

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/**
 * Stage 1 only supports .md/.markdown (plus .txt handled by the caller as
 * markdown); PDF/DOCX/LaTeX arrive in Stage 3.
 */
export function unsupportedFormat(ext: string): never {
  throw new UnsupportedFormatError(
    `Unsupported input format: ${ext} (supported: .pdf .docx .tex .md)`,
  );
}

/** Route a lowercased file extension to a reader; Stage 1 has markdown only. */
export function ingestByExtension(ext: string, read: () => string): Document {
  const suffix = ext.toLowerCase();
  if (suffix === '.md' || suffix === '.markdown' || suffix === '.txt') {
    return readMarkdown(read());
  }
  unsupportedFormat(suffix);
}

/**
 * Async dispatch (Stage 3): markdown stays sync-under-the-hood; .pdf and
 * .docx route to their heavy readers via injected byte/text accessors (no
 * Node fs in the browser — the UI passes File reader callbacks). .tex is NOT
 * supported in the browser build: the Python version uses pylatexenc, which
 * has no browser equivalent.
 */
export async function ingestByExtensionAsync(
  ext: string,
  readFileText: () => string | Promise<string>,
  readFileBuffer: () => ArrayBuffer | Promise<ArrayBuffer>,
  titleHint = '',
): Promise<Document> {
  const suffix = ext.toLowerCase();
  if (suffix === '.md' || suffix === '.markdown' || suffix === '.txt') {
    return readMarkdown(await readFileText(), 'md', titleHint);
  }
  if (suffix === '.pdf') {
    const { documentFromPdf } = await import('./pdf');
    return documentFromPdf(await readFileBuffer(), titleHint);
  }
  if (suffix === '.docx') {
    const { documentFromDocx } = await import('./docx');
    return documentFromDocx(await readFileBuffer(), titleHint);
  }
  if (suffix === '.tex') {
    throw new UnsupportedFormatError(
      '.tex not supported in the browser build (no pylatexenc equivalent); convert to .md first',
    );
  }
  unsupportedFormat(suffix);
}

function bid(i: number): string {
  return `b${String(i).padStart(5, '0')}`;
}

/**
 * Python `_ingest_markdown`: read a markdown file's text and build a Document
 * (browser-agnostic port takes the text, not a path — no Node fs here).
 * Alias kept for Python-name parity: `documentFromMarkdown`.
 */
export const readMarkdownFromText = documentFromMarkdown;

/** Python `document_from_markdown` (md path only). */
export function documentFromMarkdown(
  text: string,
  sourceFormat = 'md',
  titleHint = '',
): Document {
  const blocks: Block[] = [];
  const sections: Section[] = [];
  let currentSection: string[] = []; // hierarchical path, e.g. ["2", "2.3 Methods"]
  let sectionStart = 0;
  const fallbackTitle = titleHint || 'Untitled';
  let currentTitle = fallbackTitle;
  let docTitle = fallbackTitle;
  let referencesStart: number | undefined;

  const paras = text.split(/\n\s*\n/);
  for (const raw of paras) {
    const para = raw.trim();
    if (!para) continue;

    const hm = HEADING_RE.exec(para);
    if (hm && !para.includes('\n')) {
      const level = hm[1]!.length;
      const title = hm[2]!.trim();
      // close previous section
      if (blocks.length > 0 && blocks[blocks.length - 1]!.order - sectionStart > 0) {
        sections.push(
          new Section({
            path: currentSection.length > 0 ? [...currentSection] : [currentTitle],
            title: currentTitle,
            startBlock: sectionStart,
            endBlock: blocks.length,
          }),
        );
      }
      if (level === 1 && docTitle === fallbackTitle) {
        docTitle = title;
        currentSection = [];
        currentTitle = title;
        sectionStart = blocks.length;
        blocks.push(
          new Block({
            id: bid(blocks.length),
            type: BlockType.TITLE,
            text: title,
            sectionPath: [],
            order: blocks.length,
          }),
        );
        continue;
      }
      currentSection = [title];
      currentTitle = title;
      sectionStart = blocks.length;
      blocks.push(
        new Block({
          id: bid(blocks.length),
          type: BlockType.HEADING,
          text: title,
          sectionPath: [title],
          order: blocks.length,
        }),
      );
      if (REF_RE.test(title)) {
        referencesStart = blocks.length;
      }
      continue;
    }

    let btype = BlockType.PARAGRAPH;
    if (ABSTRACT_RE.test(para)) {
      btype = BlockType.ABSTRACT;
    } else if (EQ_RE.test(para)) {
      btype = BlockType.EQUATION;
    } else if (
      para.startsWith('- ') ||
      para.startsWith('* ') ||
      para.startsWith('+ ') ||
      /^\d+\.\s/.test(para)
    ) {
      btype = BlockType.LIST_ITEM;
    } else if (para.startsWith('```') || para.startsWith('    ')) {
      btype = BlockType.CODE;
    }
    if (para.startsWith('|') && para.trimEnd().endsWith('|')) {
      btype = BlockType.TABLE;
    }
    blocks.push(
      new Block({
        id: bid(blocks.length),
        type: btype,
        text: para,
        sectionPath: currentTitle ? [currentTitle] : [],
        order: blocks.length,
      }),
    );
    if (referencesStart === undefined && REF_RE.test(para)) {
      referencesStart = blocks.length;
    }
  }

  if (blocks.length > 0) {
    sections.push(
      new Section({
        path: [currentTitle],
        title: currentTitle,
        startBlock: sectionStart,
        endBlock: blocks.length,
      }),
    );
  }
  let refs: string | undefined;
  if (referencesStart !== undefined) {
    refs = blocks
      .slice(referencesStart)
      .map((b) => b.text)
      .join('\n\n');
  }
  return new Document({
    title: docTitle,
    sourceFormat,
    blocks,
    sections,
    referencesText: refs,
  });
}

/** Python `_ingest_markdown` equivalent: titleHint stands in for the path stem. */
export const readMarkdown = documentFromMarkdown;

// Re-exported for downstream stages that need the heuristic itself.
export { NUMBERED_HEADING_RE };
