/**
 * JSON-safe Document <-> plain-object round trip.
 *
 * The orchestrator persists a raw-document snapshot with each run so a
 * resume can re-run stages without a file re-ingest (the browser has no
 * persisted file handle). Blocks/Sections are reconstructed through their
 * constructors so `contentHash` normalization re-applies exactly as at
 * ingest; `fullText()`-level parity with the original Document is what the
 * resume path depends on.
 */

import {
  Block,
  Document,
  Section,
  type BlockInit,
  type DocumentInit,
  type Figure,
  type SectionInit,
  type TableArtifact,
  type TheoremEnvironment,
} from './document';

type SerialisableBlock = Omit<BlockInit, 'type'> & { type?: string };

export interface DocumentData {
  title?: string;
  sourceFormat?: string;
  blocks: SerialisableBlock[];
  sections: SectionInit[];
  figures: Figure[];
  tables: TableArtifact[];
  theorems: TheoremEnvironment[];
  referencesText?: string;
}

/** Snapshot a Document into a JSON-safe plain object. */
export function documentToData(doc: Document): DocumentData {
  return {
    title: doc.title,
    sourceFormat: doc.sourceFormat,
    blocks: doc.blocks.map((b) => ({
      id: b.id,
      type: b.type as unknown as string,
      text: b.text,
      ...(b.sectionPath.length > 0 ? { sectionPath: [...b.sectionPath] } : {}),
      ...(b.order !== 0 ? { order: b.order } : {}),
      ...(b.page !== undefined ? { page: b.page } : {}),
    })),
    sections: doc.sections.map((s) => ({
      path: [...s.path],
      title: s.title,
      startBlock: s.startBlock,
      endBlock: s.endBlock,
    })),
    figures: doc.figures,
    tables: doc.tables,
    theorems: doc.theorems,
    ...(doc.referencesText !== undefined ? { referencesText: doc.referencesText } : {}),
  };
}

/** Rebuild a Document from `documentToData` output (reverse of the above). */
export function documentFromData(data: DocumentData): Document {
  const init: DocumentInit = {
    title: data.title,
    sourceFormat: data.sourceFormat,
    blocks: data.blocks.map((b) => new Block(b as BlockInit)),
    sections: data.sections.map((s) => new Section(s)),
    figures: data.figures,
    tables: data.tables,
    theorems: data.theorems,
    referencesText: data.referencesText,
  };
  return new Document(init);
}
