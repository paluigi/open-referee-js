/**
 * Shared literature types — verbatim port of Python
 * `open_referee/literature/context.py` models (LiteratureItem, BibEntryCheck,
 * ContextPack) including the exact `render()` output format.
 *
 * BibEntryCheck is ported type-only here: the bibliography checker itself is
 * Stage 6; ContextPack already carries `bibChecks` so the render branches are
 * exercised now.
 */

export type LiteratureSource =
  'openalex' | 'crossref' | 'web' | 'user_pdf' | 'review_community';

export interface LiteratureItem {
  source: LiteratureSource;
  title: string;
  authors: string[];
  year?: number | null;
  doi?: string | null;
  venue?: string | null;
  citedBy?: number | null;
  abstract?: string | null;
  url?: string | null;
  /** Filled by the LLM surveyor or the scout. */
  whyRelevant?: string | null;
}

export function literatureItem(
  source: LiteratureSource,
  title: string,
): LiteratureItem {
  return { source, title, authors: [] };
}

/** Verification result for one bibliography entry (logic lands in Stage 6). */
export interface BibEntryCheck {
  rawEntry: string;
  matchedTitle?: string | null;
  matchedDoi?: string | null;
  matchedYear?: number | null;
  /** verified | year_mismatch | title_mismatch | not_found */
  status: string;
  note?: string | null;
}

export interface ContextPack {
  paperTitle: string;
  paperAbstract?: string | null;
  fieldHint?: string | null;
  items: LiteratureItem[];
  bibChecks: BibEntryCheck[];
  /** Titles of user-supplied PDFs. */
  userDocs: string[];
}

export function newContextPack(paperTitle: string): ContextPack {
  return { paperTitle, items: [], bibChecks: [], userDocs: [] };
}

/**
 * Compact text rendering for prompt injection — char-parity port of Python
 * `ContextPack.render`.
 */
export function renderPack(
  pack: ContextPack,
  maxItems = 25,
  maxAbstractChars = 700,
): string {
  const parts: string[] = [`# Field context pack (paper: ${pack.paperTitle})`];
  if (pack.fieldHint) {
    parts.push(`Detected field: ${pack.fieldHint}`);
  }
  if (pack.userDocs.length > 0) {
    parts.push(
      'Author-supplied related work (prioritized reading): ' + pack.userDocs.join('; '),
    );
  }
  for (let i = 0; i < Math.min(maxItems, pack.items.length); i++) {
    const it = pack.items[i]!;
    const n = i + 1;
    let line = `${n}. ${it.title}`;
    if (it.authors.length > 0) {
      line += ` — ${it.authors.slice(0, 3).join(', ')}`;
    }
    if (it.year) {
      line += ` (${it.year})`;
    }
    if (it.venue) {
      line += ` [${it.venue}]`;
    }
    if (it.doi) {
      line += ` doi:${it.doi}`;
    }
    if (it.citedBy !== undefined && it.citedBy !== null) {
      line += ` cited_by:${it.citedBy}`;
    }
    parts.push(line);
    if (it.abstract) {
      const a = it.abstract.slice(0, maxAbstractChars);
      parts.push(
        `   abstract: ${a}${it.abstract.length > maxAbstractChars ? '…' : ''}`,
      );
    }
    if (it.whyRelevant) {
      parts.push(`   relevance: ${it.whyRelevant}`);
    }
  }
  if (pack.bibChecks.length > 0) {
    const suspicious = pack.bibChecks.filter((b) => b.status !== 'verified');
    if (suspicious.length > 0) {
      parts.push('\nBibliography entries needing attention:');
      for (const b of suspicious) {
        parts.push(`- [${b.status}] ${b.rawEntry.slice(0, 160)} — ${b.note ?? ''}`);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Python `ContextPack.model_validate(pack)` (ed1d8da): resumed runs load
 * stage artifacts as JSON, so every ContextPack consumer must receive a real
 * pack — validate the persisted artifact back into the ContextPack shape,
 * defaulting every field (items/bibChecks/userDocs arrays, paperTitle).
 * Returns undefined when the artifact is not a pack-shaped object.
 */
export function contextPackFromArtifact(raw: unknown): ContextPack | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    paperTitle: typeof o['paperTitle'] === 'string' ? o['paperTitle'] : '',
    paperAbstract: typeof o['paperAbstract'] === 'string' ? o['paperAbstract'] : null,
    fieldHint: typeof o['fieldHint'] === 'string' ? o['fieldHint'] : null,
    items: arr(o['items']) as LiteratureItem[],
    bibChecks: arr(o['bibChecks']) as BibEntryCheck[],
    userDocs: arr(o['userDocs']) as string[],
  };
}

/** Python `re.sub(r'\W+', '', title.lower())[:80]` — the dedupe key. */
export function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/\W+/g, '').slice(0, 80);
}
