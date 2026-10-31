/**
 * Deterministic checkers: cross-references, number consistency, table
 * arithmetic.
 *
 * Port of Python `open_referee/pipeline/checkers.py` (origin/main 26ae883).
 * These run with zero LLM cost and produce `CheckFinding` records that join
 * the candidate-comment stream (provenance `deterministic`). All thresholds
 * are conservative: a finding that is wrong is worse than a missing one, so
 * ambiguous structures (unparsable tables, unit-less plain integers) are
 * skipped rather than guessed.
 */

import type { BlockType, Document } from '../ingestion/document';

// ----------------------------------------------------------------- findings --

export interface CheckFinding {
  /** xref | consistency | table-arithmetic | doi-resolution | recompute */
  check: string;
  title: string;
  message: string;
  quote?: string;
  section?: string | null;
  category?: string;
  severity?: number;
  meta?: Record<string, unknown>;
}

/**
 * Python `CheckFinding.to_dict()`: the dataclass as a dict plus the
 * provenance tag (`deterministic`; `recompute` is reserved for 7h).
 */
export function findingToDict(f: CheckFinding): Record<string, unknown> {
  return {
    check: f.check,
    title: f.title,
    message: f.message,
    quote: f.quote ?? '',
    section: f.section ?? null,
    category: f.category ?? 'consistency',
    severity: f.severity ?? 0.5,
    meta: f.meta ?? {},
    provenance: f.check !== 'recompute' ? 'deterministic' : 'recompute',
  };
}

// ------------------------------------------------------ cross-reference check --

const LABEL_DEF_RE =
  /^(figure|table|theorem|lemma|proposition|corollary|definition|algorithm|appendix)\s+([0-9]+[A-Z]?|[A-Z])(?![0-9A-Za-z])/i;
const LABEL_REF_RE =
  /\b(figure|fig\.|table|theorem|thm\.|lemma|proposition|prop\.|corollary|definition|algorithm)\s*~?\s*([0-9]+[A-Z]?)\b|\b(appendix)\s*~?\s+([A-Z])(?![a-z])/gi;
const EQ_DEF_RE = /(?:\\tag\{([0-9]+[a-z]?)\}|\(([0-9]+[a-z]?)\)\s*$)/;
const EQ_REF_RE = /\b(?:equation|eq\.?s?|expression)\s*?\(?([0-9]+[a-z]?)\)?/gi;
const SECTION_REF_RE = /\b(?:section|sect\.?)\s+([0-9]+(?:\.[0-9]+)*)\b/gi;
const NUM_MONOTONE_RE = /^[0-9]+/;
/** A line anywhere in the text that looks like a numbered (sub)section heading. */
const ANY_NUMBERED_LINE_RE = /^\s*\d{1,2}(?:\.\d{1,2}){0,2}[.:]?\s+[A-Z]\S.*$/;

const CLASS_CANON: Record<string, string> = {
  figure: 'Figure',
  'fig.': 'Figure',
  table: 'Table',
  theorem: 'Theorem',
  'thm.': 'Theorem',
  lemma: 'Lemma',
  proposition: 'Proposition',
  'prop.': 'Proposition',
  corollary: 'Corollary',
  definition: 'Definition',
  algorithm: 'Algorithm',
  appendix: 'Appendix',
  equation: 'Equation',
  'eq.': 'Equation',
  'eqs.': 'Equation',
  expression: 'Equation',
};

/** Definitions are rarely referenced by number. */
const SKIP_CLASS_FOR_REFS = new Set(['Definition']);
const MAX_XREF_FINDINGS = 8;

const DEF_PUNCT = new Set([':', '.', ',', ';', ')', '—', '–', '-']);

/** Python `cross_reference_check`, faithful. */
export function crossReferenceCheck(doc: Document): CheckFinding[] {
  const findings: CheckFinding[] = [];
  /** class -> [(label, block_id)] in definition order. */
  const defined = new Map<string, [string, string][]>();

  const define = (cls: string, labelId: string, blockId: string): void => {
    const list = defined.get(cls);
    if (list) list.push([labelId, blockId]);
    else defined.set(cls, [[labelId, blockId]]);
  };

  for (const th of doc.theorems) {
    const m = /^([A-Za-z]+)\s+(.+)/.exec(th.label ?? '');
    if (m) {
      const canon = CLASS_CANON[m[1]!.toLowerCase()];
      if (canon !== undefined) {
        define(canon, m[2]!, th.statementBlockId ?? '');
      }
    }
  }
  for (const fig of doc.figures) {
    if (fig.caption) {
      const m = /^(?:figure|fig\.?)\s*([0-9]+[A-Z]?)/i.exec(fig.caption.trim());
      if (m) define('Figure', m[1]!, fig.captionBlockId ?? '');
    }
  }
  for (const tab of doc.tables) {
    if (tab.caption) {
      const m = /^(?:table)\s*([0-9]+[A-Z]?)/i.exec(tab.caption.trim());
      if (m) define('Table', m[1]!, tab.captionBlockId ?? '');
    }
  }
  for (const b of doc.blocks) {
    // Label definitions may sit at the start of any line inside a block
    // (captions, bold pseudo-headings, theorem statements).
    const lines = b.text.split('\n').slice(0, 3);
    for (const line of lines) {
      const s = line.trim();
      if (!(s.length > 3 && s.length < 220)) continue;
      if (b.type === ('paragraph' as BlockType) && s.length >= 120) {
        continue; // long body paragraphs are prose, not labels
      }
      const m = LABEL_DEF_RE.exec(s);
      if (m && looksLikeDefinition(s, m[0].length)) {
        define(CLASS_CANON[m[1]!.toLowerCase()]!, m[2]!, b.id);
        break;
      }
      if (b.type === ('equation' as BlockType)) {
        const em = EQ_DEF_RE.exec(s);
        if (em) {
          define('Equation', em[1] ?? em[2]!, b.id);
          break;
        }
      }
    }
  }

  // Section-number registry: parsed sections plus ANY numbered heading-like
  // line in the text (bold/plain subsections that never parsed as headings).
  const sectionNumbers = new Set<string>();
  for (const s of doc.sections) {
    const m = /^([0-9]+(?:\.[0-9]+)*)\.?\s/.exec(s.title);
    if (m) sectionNumbers.add(m[1]!);
  }
  for (const b of doc.blocks) {
    for (const line of b.text.split('\n')) {
      if (ANY_NUMBERED_LINE_RE.test(line) && line.trim().length < 120) {
        const m = /^\s*(\d{1,2}(?:\.\d{1,2}){0,2})/.exec(line);
        if (m) sectionNumbers.add(m[1]!);
      }
    }
  }

  // Duplicate labels + non-monotone numbering per class.
  const duplicatedClasses = new Set<string>();
  for (const [cls, items] of defined) {
    const seen = new Map<string, string>();
    for (const [labelId, blockId] of items) {
      if (seen.has(labelId)) {
        if (!duplicatedClasses.has(cls)) {
          duplicatedClasses.add(cls);
          findings.push({
            check: 'xref',
            title: `Duplicate label ${cls} ${labelId}`,
            message:
              `${cls} ${labelId} is defined more than once; ` +
              'references to it are ambiguous. This usually ' +
              'means a renumbering after edits missed a copy.',
            quote: quoteBlock(doc, blockId),
            category: 'reference',
            severity: 0.45,
            meta: { class: cls, label: labelId, kind: 'duplicate' },
          });
        }
        break; // one report per class is enough
      }
      seen.set(labelId, blockId);
    }
    if (duplicatedClasses.has(cls)) continue;
    const nums: number[] = [];
    for (const [lid] of items) {
      const m = NUM_MONOTONE_RE.exec(lid);
      if (m) nums.push(parseInt(m[0], 10));
    }
    if (
      nums.length >= 3 &&
      JSON.stringify(nums) !== JSON.stringify([...nums].sort((a, b) => a - b))
    ) {
      findings.push({
        check: 'xref',
        title: `${cls} numbering is not monotone`,
        message:
          `${cls} numbers appear out of order in the document ` +
          `([${nums.join(', ')}]); check for renumbering after edits.`,
        category: 'reference',
        severity: 0.3,
        meta: { class: cls, kind: 'ordering', sequence: nums },
      });
    }
  }

  // Dangling references, aggregated per (class,label) and per section-number.
  // Classes with zero definitions anywhere (extraction loss) collapse into
  // one low-severity note instead of one finding per label.
  const dangling = new Map<
    string,
    { count: number; quote: string; section: string | null }
  >();
  const orphanClasses = new Map<string, number>();
  const missingSections = new Map<
    string,
    { count: number; quote: string; section: string | null }
  >();
  for (const b of doc.blocks) {
    if (b.type === ('heading' as BlockType)) continue;
    for (const m of b.text.matchAll(LABEL_REF_RE)) {
      const clsRaw = m[1] ?? m[3];
      const labelId = m[1] ? m[2]! : m[4]!;
      const cls = clsRaw !== undefined ? CLASS_CANON[clsRaw.toLowerCase()] : undefined;
      if (cls === undefined || SKIP_CLASS_FOR_REFS.has(cls)) continue;
      const labels = defined.get(cls) ?? [];
      if (labels.some(([lid]) => lid === labelId)) continue;
      if ((defined.get(cls) ?? []).length === 0) {
        orphanClasses.set(cls, (orphanClasses.get(cls) ?? 0) + 1);
        continue;
      }
      const key = `${cls}\u0000${labelId}`;
      const slot = dangling.get(key) ?? { count: 0, quote: '', section: null };
      slot.count += 1;
      if (!slot.quote) {
        slot.quote = windowQuote(b.text, m.index);
        slot.section = sectionOf(doc, b.id);
      }
      dangling.set(key, slot);
    }
    for (const m of b.text.matchAll(EQ_REF_RE)) {
      const eqId = m[1]!;
      if (!/^[0-9]+$/.test(eqId)) continue;
      const eqLabels = defined.get('Equation') ?? [];
      if (eqLabels.length > 0 && !eqLabels.some(([lid]) => lid === eqId)) {
        const key = `Equation\u0000${eqId}`;
        const slot = dangling.get(key) ?? { count: 0, quote: '', section: null };
        slot.count += 1;
        if (!slot.quote) {
          slot.quote = windowQuote(b.text, m.index);
          slot.section = sectionOf(doc, b.id);
        }
        dangling.set(key, slot);
      }
    }
    for (const m of b.text.matchAll(SECTION_REF_RE)) {
      if (sectionNumbers.size > 0 && !sectionNumbers.has(m[1]!)) {
        const slot = missingSections.get(m[1]!) ?? {
          count: 0,
          quote: '',
          section: null,
        };
        slot.count += 1;
        if (!slot.quote) {
          slot.quote = windowQuote(b.text, m.index);
          slot.section = sectionOf(doc, b.id);
        }
        missingSections.set(m[1]!, slot);
      }
    }
  }

  for (const [key, slot] of [...dangling.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const [cls, labelId] = key.split('\u0000') as [string, string];
    findings.push({
      check: 'xref',
      title:
        `Reference to undefined ${cls} ${labelId}` +
        (slot.count > 1 ? ` (${slot.count}×)` : ''),
      message:
        `The text refers to ${cls} ${labelId}, but no ${cls} with ` +
        'that number is defined anywhere in the document' +
        (slot.count > 1 ? ` — ${slot.count} references in total` : '') +
        '.',
      quote: slot.quote,
      section: slot.section,
      category: 'reference',
      severity: 0.35,
      meta: {
        class: cls,
        label: labelId,
        kind: 'dangling',
        occurrences: slot.count,
      },
    });
  }
  if (missingSections.size > 0) {
    const worst = [...missingSections.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    )[0]!;
    const numsStr = [...missingSections.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([n, s]) => (s.count > 1 ? `${n} (${s.count}×)` : n))
      .join(', ');
    findings.push({
      check: 'xref',
      title: 'References to sections without matching headings',
      message:
        'The text cites section numbers that do not match any ' +
        `section heading or numbered block: ${numsStr}. Check ` +
        'whether a renumbering or a formatting loss in conversion ' +
        'broke the internal structure.',
      quote: worst[1].quote,
      section: worst[1].section,
      category: 'reference',
      severity: 0.35,
      meta: {
        kind: 'section-refs',
        missing: Object.fromEntries(
          [...missingSections.entries()].map(([n, s]) => [n, s.count]),
        ),
      },
    });
  }
  if (orphanClasses.size > 0) {
    for (const [cls, n] of [...orphanClasses.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )) {
      findings.push({
        check: 'xref',
        title: `No ${cls.toLowerCase()} captions found for ${n} reference(s)`,
        message:
          `The text references ${cls.toLowerCase()}s ${n} times, but the ` +
          'document contains no ' +
          `${cls.toLowerCase()} captions or definitions at all — most ` +
          'likely the figures were images lost in conversion. ' +
          'Internal reference checking for this class is ' +
          'therefore not possible; treat as unverified.',
        category: 'reference',
        severity: 0.2,
        meta: { class: cls, kind: 'orphan-class', references: n },
      });
    }
  }
  return findings.slice(0, MAX_XREF_FINDINGS);
}

/** Python `_looks_like_definition`: caption punctuation must follow the label. */
function looksLikeDefinition(line: string, matchEnd: number): boolean {
  const rest = line.slice(matchEnd).replace(/^\s+/, '');
  if (rest === '') return true;
  return DEF_PUNCT.has(rest[0]!);
}

/** Python `_quote_block`: the block's text truncated to 240 chars. */
function quoteBlock(doc: Document, blockId: string): string {
  for (const b of doc.blocks) {
    if (b.id === blockId) return b.text.slice(0, 240);
  }
  return '';
}

/** Python `_section_of`: the first segment of the block's section path. */
function sectionOf(doc: Document, blockId: string): string | null {
  for (const b of doc.blocks) {
    if (b.id === blockId) return b.sectionPath.length > 0 ? b.sectionPath[0]! : null;
  }
  return null;
}

/** Python `_window`: ±width context window around a match, clipped to 240. */
function windowQuote(text: string, pos: number, width = 110): string {
  const lo = Math.max(0, pos - Math.floor(width / 2));
  return text
    .slice(lo, pos + width)
    .trim()
    .slice(0, 240);
}

// ----------------------------------------------------- number consistency --

const NUM_RE =
  /(?<![0-9A-Za-z.])(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d+)(?![0-9])\s?(%|pp\b|percentage points|per cent\b)?/gi;
const DOI_TOKEN_RE = /^10\.\d{4,}/;
const LATEX_PREFIX_RE = /(\\[a-z]+|\barray\b|\bbegin\b|\bend\b|\bfrac\b|\\\$)/;

const GENERIC_TAIL = new Set([
  'estimate',
  'estimates',
  'value',
  'values',
  'number',
  'numbers',
  'result',
  'results',
  'increase',
  'decrease',
  'level',
  'levels',
  'rate',
  'rates',
  'size',
  'sizes',
  'sample',
  'samples',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

const CONNECTORS = new Set([
  'of',
  'is',
  'as',
  'was',
  'at',
  'in',
  'to',
  'and',
  'the',
  'a',
  'an',
  'for',
  'with',
  'by',
  'on',
  'from',
  'are',
  'were',
  'has',
  'have',
  'equals',
  'equal',
  'per',
  'about',
  'over',
  'under',
]);

const PROSE_BLOCKS = new Set(['paragraph', 'abstract', 'caption']);

const STRUCTURAL_TAIL = new Set([
  'section',
  'sections',
  'figure',
  'figures',
  'table',
  'tables',
  'equation',
  'equations',
  'appendix',
  'page',
  'pages',
  'fig',
  'chapter',
  'step',
  'steps',
  'period',
  'wave',
]);

/** Python `_decimals`: the number of digits after the decimal point. */
function decimals(tok: string): number {
  const idx = tok.indexOf('.');
  return idx === -1 ? 0 : tok.length - idx - 1;
}

/** Python `_value`: the numeric value of a token (commas removed). */
function valueOf(tok: string): number {
  return parseFloat(tok.replace(/,/g, ''));
}

/** Python `_consistent`: the rounding/relative tolerance pair-test. */
export function consistent(aTok: string, bTok: string): boolean {
  const a = valueOf(aTok);
  const b = valueOf(bTok);
  const minDec = Math.min(decimals(aTok), decimals(bTok));
  if (minDec > 0 && Math.abs(a - b) <= 0.6 * Math.pow(10, -minDec)) {
    return true;
  }
  return Math.abs(a - b) <= Math.max(1e-9, 0.01 * Math.max(Math.abs(a), Math.abs(b)));
}

interface Mention {
  tok: string;
  unit: string | undefined;
  words: string[];
  block: { type: string; text: string };
  pos: number;
}

/** Python `number_consistency_check`, faithful. */
export function numberConsistencyCheck(doc: Document): CheckFinding[] {
  const [abstractBlocks, bodyBlocks] = splitAbstract(doc);
  if (!abstractBlocks || abstractBlocks.length === 0) return [];
  const head = mentions(abstractBlocks);
  if (head.length === 0) return [];
  const tail = mentions((bodyBlocks ?? []).filter((b) => PROSE_BLOCKS.has(b.type)));

  const findings: CheckFinding[] = [];
  for (const hm of head) {
    const candidates = tail.filter(
      (tm) => sameQuantity(hm.words, tm.words) && !consistent(hm.tok, tm.tok),
    );
    // Contradictions inside the abstract itself count too.
    const inside = head.filter(
      (om) =>
        om !== hm && sameQuantity(hm.words, om.words) && !consistent(hm.tok, om.tok),
    );
    const conflicts = [...candidates, ...inside];
    if (conflicts.length === 0) continue;
    const other = conflicts[0]!;
    const [a, b] = [hm.tok, other.tok].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const template = hm.words.slice(-3).join(' ');
    const dup = findings.some((f) => {
      const meta = (f.meta ?? {}) as { template?: unknown; values?: unknown };
      const vals = Array.isArray(meta.values) ? meta.values : [null, null];
      return (
        meta.template === template &&
        JSON.stringify(vals.slice(0, 2)) === JSON.stringify([a, b])
      );
    });
    if (dup) continue;
    const quotes = [
      `[${hm.block.type}] …${windowQuote(hm.block.text, hm.pos, 90)}…`,
      `[${other.block.type}] …${windowQuote(other.block.text, other.pos, 90)}…`,
    ];
    findings.push({
      check: 'consistency',
      title: `Conflicting values for "${template}" (${a} vs ${b})`,
      message:
        `The quantity described as "${template}" is reported as ${a} ` +
        `in one place and ${b} in another; at most one can be ` +
        'correct. Verify which value is right and align the others.',
      quote: quotes.join('\n\n'),
      category: 'consistency',
      severity: 0.7,
      meta: { template, values: [a, b] },
    });
  }
  return findings;
}

/** Python `_split_abstract`: explicit abstract blocks or the front-matter proxy. */
function splitAbstract(doc: Document): { type: string; text: string }[][] {
  const abstract = doc.blocks.filter((b) => b.type === ('abstract' as BlockType));
  if (abstract.length > 0) {
    const rest = doc.blocks.filter((b) => b.type !== ('abstract' as BlockType));
    return [abstract, rest];
  }
  // No explicit abstract block: the first few paragraphs before the first
  // real section heading act as the abstract proxy.
  const head: typeof doc.blocks = [];
  const rest: typeof doc.blocks = [];
  let seenHeading = false;
  for (const b of doc.blocks) {
    if (b.type === ('title' as BlockType)) {
      rest.push(b);
      continue;
    }
    if (b.type === ('heading' as BlockType)) {
      if (
        !seenHeading &&
        ['abstract', 'summary'].includes(
          b.text
            .trim()
            .toLowerCase()
            .replace(/[:.]+$/, ''),
        )
      ) {
        continue; // abstract heading itself — what follows is still front matter
      }
      seenHeading = true;
      rest.push(b);
      continue;
    }
    (seenHeading || head.length >= 3 ? rest : head).push(b);
  }
  return [head, rest];
}

/** Python `_mentions`: quantity mentions with their word templates. */
function mentions(blocks: { type: string; text: string }[]): Mention[] {
  const out: Mention[] = [];
  for (const b of blocks) {
    for (const m of b.text.matchAll(NUM_RE)) {
      const tok = m[1]!;
      const unit = m[2];
      if (!tok.includes('.') && unit === undefined) {
        continue; // plain integers: counts/years — not quantity claims
      }
      if (decimals(tok) === 0 && Math.abs(valueOf(tok)) < 10 && unit === undefined) {
        continue;
      }
      if (/^(19|20)\d\d$/.test(tok)) continue; // years
      if (DOI_TOKEN_RE.test(tok)) continue; // DOIs in references
      const prefixRaw = b.text.slice(Math.max(0, m.index - 60), m.index);
      if (LATEX_PREFIX_RE.test(prefixRaw)) continue; // inside math/LaTeX
      const prefix = prefixRaw.toLowerCase().replace(/[\d,.%]+/g, ' # ');
      const words = prefix.match(/[a-z][a-z-]{1,}/g) ?? [];
      if (words.length < 2) continue;
      const contentWords = words.filter((w) => !CONNECTORS.has(w));
      if (
        contentWords.length === 0 ||
        GENERIC_TAIL.has(contentWords[contentWords.length - 1]!) ||
        STRUCTURAL_TAIL.has(contentWords[contentWords.length - 1]!)
      ) {
        continue; // names no specific quantity (a value of / section 5.1)
      }
      out.push({
        tok,
        unit,
        words,
        block: { type: b.type, text: b.text },
        pos: m.index,
      });
    }
  }
  return out;
}

/**
 * Python `_same_quantity`: two mention prefixes name the same quantity when
 * their last two content words (connectors ignored) agree.
 */
function sameQuantity(wordsA: string[], wordsB: string[]): boolean {
  const ca = wordsA.filter((w) => !CONNECTORS.has(w));
  const cb = wordsB.filter((w) => !CONNECTORS.has(w));
  return (
    ca.length >= 2 &&
    cb.length >= 2 &&
    ca[ca.length - 2] === cb[cb.length - 2] &&
    ca[ca.length - 1] === cb[cb.length - 1]
  );
}

// ------------------------------------------------------- table arithmetic --

const TOTAL_RE = /^(total|sum|all)\b/i;
const ROW_SPLIT_RE = /\s*\|\s*/;

/** Python `_parse_md_table`: pipe-table rows, separator rows skipped. */
export function parseMdTable(md: string): string[][] | null {
  const rows: string[][] = [];
  for (const rawLine of md.trim().split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|+/, '')
      .replace(/\|+$/, '')
      .split(ROW_SPLIT_RE)
      .map((c) => c.trim());
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) {
      continue; // separator row
    }
    rows.push(cells);
  }
  if (rows.length < 3) return null;
  return rows;
}

/** Python `_num`: a numeric cell (paren-negatives, commas, %, unicode minus). */
export function num(cell: string): number | null {
  const s = cell.trim().replace(/,/g, '').replace(/%/g, '').replace(/−/g, '-');
  if (!/^\(?\s*-?\d+(?:\.\d+)?\s*\)?$/.test(s)) return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  const v = parseFloat(s.replace(/^\(+/, '').replace(/\)+$/, ''));
  return neg ? -v : v;
}

/** Python `table_arithmetic_check`, faithful. */
export function tableArithmeticCheck(doc: Document): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const tables: [string, string | null, string][] = [];
  for (const t of doc.tables) {
    if (t.markdown) tables.push([t.id, t.caption ?? null, t.markdown]);
  }
  for (const b of doc.blocks) {
    if (b.type === ('table' as BlockType)) tables.push([b.id, null, b.text]);
  }
  for (const [tid, caption, md] of tables) {
    const rows = parseMdTable(md);
    if (!rows) continue;
    const header = rows[0]!;
    const body = rows.slice(1);
    // Total row: each numeric cell should equal the column sum above it.
    for (let i = 0; i < body.length; i++) {
      const row = body[i]!;
      if (row.length === 0 || !TOTAL_RE.test(row[0] ?? '')) continue;
      for (let col = 1; col < row.length; col++) {
        const total = num(row[col]!);
        if (total === null) continue;
        const above: number[] = [];
        for (const r of body.slice(0, i)) {
          if (col < r.length) {
            const v = num(r[col]!);
            if (v !== null) above.push(v);
          }
        }
        if (above.length < 2) continue;
        const s = above.reduce((acc, v) => acc + v, 0);
        const tol = Math.max(
          0.5 * Math.pow(10, -decimalsOfSix(total)),
          Math.abs(total) * 0.005,
          1e-9,
        );
        if (Math.abs(s - total) > tol) {
          const label = col < header.length ? header[col]! : `column ${col}`;
          findings.push({
            check: 'table-arithmetic',
            title: `Total row does not sum: ${label} (${tid})`,
            message:
              `The "${row[0]}" row reports ${gFormat(total)} for ` +
              `"${label}", but the rows above sum to ${gFormat(s)}. ` +
              'Recomputed from the table itself.' +
              (caption ? ` (${caption})` : ''),
            quote: tableQuote(md, row),
            category: 'consistency',
            severity: 0.7,
            meta: { table: tid, column: label, reported: total, computed: s },
          });
        }
      }
    }
    // "total"-named column: each row's cell should equal the row's part sum.
    for (let col = 1; col < header.length; col++) {
      const h = header[col]!;
      if (!/\b(total|sum)\b/i.test(h)) continue;
      for (const row of body) {
        if (TOTAL_RE.test(row[0] ?? '')) continue;
        const total = col < row.length ? num(row[col]!) : null;
        if (total === null) continue;
        const parts: number[] = [];
        for (let c = 1; c < row.length; c++) {
          if (
            c === col ||
            c >= row.length ||
            /\b(total|share|sum|%)\b/i.test(header[c] ?? '')
          ) {
            continue;
          }
          const v = num(row[c]!);
          if (v !== null) parts.push(v);
        }
        if (parts.length < 2) continue;
        const s = parts.reduce((acc, v) => acc + v, 0);
        if (Math.abs(s - total) > Math.max(Math.abs(total) * 0.005, 0.01)) {
          findings.push({
            check: 'table-arithmetic',
            title: `Row total mismatch in ${tid}: ${row[0]}`,
            message:
              `Row "${row[0]}": the "${h}" column reports ` +
              `${gFormat(total)} but the row's other numeric columns ` +
              `sum to ${gFormat(s)}.` +
              (caption ? ` (${caption})` : ''),
            quote: tableQuote(md, row),
            category: 'consistency',
            severity: 0.7,
            meta: { table: tid, row: row[0], reported: total, computed: s },
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Python `_decimals(f"{total:.6f}".rstrip("0"))`: decimals of the total
 * formatted to 6 places with trailing zeros stripped. (Python `rstrip`
 * strips the trailing dot too via the split logic — verified against the
 * Python fixtures.)
 */
function decimalsOfSix(total: number): number {
  const s = total.toFixed(6).replace(/0+$/, '');
  const idx = s.indexOf('.');
  return idx === -1 ? 0 : s.length - idx - 1;
}

/**
 * Python `f"{x:g}"`: %g formatting — 6 significant digits, %e vs %f style
 * chosen by exponent, trailing zeros stripped, ROUND-HALF-EVEN on the exact
 * binary value (JS toFixed/toPrecision round ties away from zero, so the
 * rounding runs on the exact decimal expansion of the double via BigInt).
 * Verified against Python for the test fixtures (incl. the 123456.5 tie).
 */
export function gFormat(v: number): string {
  if (v === 0) return '0';
  if (!Number.isFinite(v)) return String(v);
  const PRECISION = 6;
  const neg = v < 0;
  const { digits, pointPos } = exactDigits(Math.abs(v));
  // round-half-even to PRECISION significant digits
  let ds = digits;
  let pp = pointPos;
  if (ds.length > PRECISION) {
    const keep = ds.slice(0, PRECISION);
    const roundDigit = ds[PRECISION]!;
    const rest = ds.slice(PRECISION + 1);
    let roundUp: boolean;
    if (roundDigit > '5' || (roundDigit === '5' && /[^0]/.test(rest))) {
      roundUp = true;
    } else if (roundDigit === '5') {
      roundUp = keep[PRECISION - 1]!.charCodeAt(0) % 2 === 1; // tie -> even
    } else {
      roundUp = false;
    }
    if (roundUp) {
      let carried = `${BigInt(keep) + 1n}`;
      if (carried.length > PRECISION) {
        // 999999 -> 1000000: point moves
        carried = carried.slice(0, PRECISION);
        pp += 1;
      }
      ds = carried;
    } else {
      ds = keep;
    }
  }
  const X = pp - 1; // exponent of the leading digit
  const strip = (s: string): string => s.replace(/0+$/, '').replace(/\.$/, '');
  let body: string;
  if (X >= -4 && X < PRECISION) {
    const padded = pp <= 0 ? '0'.repeat(1 - pp) + ds : ds;
    const cut = pp > 0 ? pp : 1;
    body = strip(`${padded.slice(0, cut)}.${padded.slice(cut)}`);
    if (body === '' || body === '.') body = '0';
  } else {
    const mant = strip(`${ds[0]}.${ds.slice(1)}`);
    const sign = X >= 0 ? '+' : '-';
    body = `${mant}e${sign}${String(Math.abs(X)).padStart(2, '0')}`;
  }
  return (neg ? '-' : '') + body;
}

interface ExactDigits {
  /** decimal digits of |v| with no leading zeros (v !== 0) */
  digits: string;
  /** position of the decimal point: value = 0.digits × 10^pointPos */
  pointPos: number;
}

/** Exact decimal expansion of a finite double via its IEEE-754 bits. */
function exactDigits(v: number): ExactDigits {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, v);
  const hi = BigInt(dv.getUint32(0));
  const lo = BigInt(dv.getUint32(4));
  const rawExp = (hi >> 20n) & 0x7ffn;
  let mantissa = ((hi & 0xfffffn) << 32n) | lo;
  let exp2 = Number(rawExp) - 1075;
  if (rawExp === 0n) {
    // subnormal: implicit bit is 0
    exp2 = -1074;
  } else {
    mantissa |= 1n << 52n;
  }
  if (exp2 >= 0) {
    const s = (mantissa << BigInt(exp2)).toString();
    return { digits: s, pointPos: s.length };
  }
  const k = -exp2;
  // value = mantissa / 2^k = mantissa * 5^k / 10^k
  const s = (mantissa * 5n ** BigInt(k)).toString();
  return { digits: s, pointPos: s.length - k };
}

/** Python `_table_quote`: the matching source line, or the row joined. */
function tableQuote(md: string, row: string[]): string {
  let line = '';
  for (const ln of md.split('\n')) {
    const t = ln.trim();
    if (
      t.startsWith('|') &&
      row.length > 0 &&
      row[0] !== '' &&
      row[0] !== undefined &&
      t.includes(row[0])
    ) {
      line = ln;
      break;
    }
  }
  const stripped = line.trim().slice(0, 240);
  return stripped || row.join(' | ').slice(0, 240);
}

// ------------------------------------------------------------------- entry --

/** Python `run_deterministic_checks`: the three checks in order. */
export function runDeterministicChecks(doc: Document): CheckFinding[] {
  const out: CheckFinding[] = [];
  out.push(...crossReferenceCheck(doc));
  out.push(...numberConsistencyCheck(doc));
  out.push(...tableArithmeticCheck(doc));
  return out;
}
