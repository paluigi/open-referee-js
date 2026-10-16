/**
 * Artifact extraction: theorem environments, markdown tables, definitions
 * pack.
 *
 * Port of Python `open_referee/ingestion/artifacts.py`. Regexes are byte-
 * identical to the Python source — with ONE documented divergence: the
 * latex-command symbol regex (Python uses a double-backslash that never
 * matches; see collectSymbols below). PDF table extraction lives in
 * readers/pdf.ts; this module keeps the format-independent logic so
 * markdown/docx documents get the same treatment.
 */

import { Block, BlockType, Document } from './document';
import type { TableArtifact, TheoremEnvironment } from './document';

/** `Theorem 1.2:` / `Lemma A` / `COROLLARY 3` ... (case-insensitive). */
export const THEOREM_RE =
  /^(Theorem|Lemma|Proposition|Corollary|Definition|Assumption|Claim)\s*([0-9]+(?:\.[0-9]+)*|[A-Z])?\s*[.:]?/i;
/** `Proof`, `Proof.`, `Proof:`, `Demonstration` at line start. */
export const PROOF_RE = /^(Proof|Proof\.|Proof:|Demonstration)\b/i;
/** Tombstone: □, $\blacksquare$, or Q.E.D. at end of text. */
export const QED_RE = /(□|\$\\blacksquare\$|Q\.?E\.?D\.?\s*$)/i;
/** Prose definition: "X is/are/denotes ...". */
export const DEF_RE =
  /^([A-Za-z][A-Za-z\- ]{0,40}?)\s+(?:is|are|denotes?|is defined as|shall be)\b/;

export const DEF_BLOCK_TYPES = new Set([
  BlockType.EQUATION,
  BlockType.PARAGRAPH,
  BlockType.ABSTRACT,
]);

/**
 * Python `extract_theorems`: walk blocks, pair theorem statements with their
 * proofs, capture labels. A statement absorbs following blocks until a Proof,
 * a new theorem, or a heading; the proof absorbs until a QED marker, a new
 * theorem, or a heading.
 */
export function extractTheorems(doc: Document): TheoremEnvironment[] {
  const out: TheoremEnvironment[] = [];
  const blocks = doc.blocks;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    const m = THEOREM_RE.exec(b.text.trim());
    if (m) {
      const kind = m[1]!.toLowerCase();
      const label = (m[1] + (m[2] ? ' ' + m[2] : '')).trim();
      let statement = b.text.trim();
      // absorb until Proof, a new theorem, or a heading
      let j = i + 1;
      while (j < blocks.length) {
        const t = blocks[j]!.text.trim();
        if (
          PROOF_RE.test(t) ||
          THEOREM_RE.test(t) ||
          blocks[j]!.type === BlockType.HEADING
        ) {
          break;
        }
        statement += '\n\n' + t;
        j += 1;
      }
      const env: TheoremEnvironment = {
        kind,
        label,
        statement,
        statementBlockId: b.id,
      };
      // proof: immediately following blocks starting with Proof
      if (j < blocks.length && PROOF_RE.test(blocks[j]!.text.trim())) {
        let proof = blocks[j]!.text.trim();
        let k = j + 1;
        while (k < blocks.length) {
          const t = blocks[k]!.text.trim();
          if (THEOREM_RE.test(t) || blocks[k]!.type === BlockType.HEADING) {
            break;
          }
          proof += '\n\n' + t;
          k += 1;
          if (QED_RE.test(t)) {
            break;
          }
        }
        env.proof = proof;
        env.proofBlockId = blocks[j]!.id;
        i = k;
      } else {
        i = j;
      }
      out.push(env);
    } else {
      i += 1;
    }
  }
  return out;
}

/** Python `_caption_near`: "Table 3" / "Tab. 3" text (or CAPTION block) within ±window. */
function captionNear(doc: Document, block: Block, window = 2): string | undefined {
  const lo = Math.max(0, block.order - window);
  for (const b of doc.blocks.slice(lo, block.order + window + 1)) {
    const t = b.text.trim();
    if (/^(Table|Tab\.)\s*\d+/i.test(t) || b.type === BlockType.CAPTION) {
      return t;
    }
  }
  return undefined;
}

/**
 * Python `extract_tables`: markdown pipe-table blocks become TableArtifacts
 * (PDF tables are attached by the PDF reader).
 */
export function extractTables(doc: Document): TableArtifact[] {
  const out: TableArtifact[] = [];
  let n = 0;
  for (const b of doc.blocks) {
    if (b.type === BlockType.TABLE && b.text.trim().startsWith('|')) {
      n += 1;
      out.push({
        id: `tbl_md_${String(n).padStart(2, '0')}`,
        page: b.page,
        markdown: b.text,
        caption: captionNear(doc, b),
        captionBlockId: b.id,
      });
    }
  }
  return out;
}

/**
 * Python `build_definitions_pack`: compact pack of definitions/notation the
 * theorem environment uses. Heuristic symbol collection — symbols appearing
 * in the statement/proof are matched against blocks that define things
 * (DEF_RE prose definitions, equation blocks, and earlier theorem
 * environments of kind definition/assumption). Kept small — this is context,
 * not the full paper.
 */
export function buildDefinitionsPack(doc: Document, env: TheoremEnvironment): string {
  const body = env.statement + '\n' + (env.proof ?? '');
  const symbols = collectSymbols(body);
  const lines: string[] = [];
  const seen = new Set<string>();

  // explicit definition/assumption environments first
  for (const other of doc.theorems) {
    if (
      (other.kind === 'definition' || other.kind === 'assumption') &&
      other.label &&
      !seen.has(other.label)
    ) {
      if (
        other !== env &&
        (overlap(symbols, other.statement) >= 2 || sameSection(doc, env, other))
      ) {
        lines.push(`[${other.label}] ${other.statement.slice(0, 600)}`);
        seen.add(other.label);
      }
    }
  }

  // prose definitions and numbered equations
  for (const b of doc.blocks) {
    const t = b.text.trim();
    if (!t || seen.has(t)) continue;
    const isDef = DEF_RE.test(t);
    const isEq = b.type === BlockType.EQUATION || /^\(\d+\)/.test(t);
    if (!(isDef || isEq)) continue;
    if (overlap(symbols, t) >= 2) {
      const label = b.id;
      lines.push(`[${label}] ${t.slice(0, 400)}`);
      seen.add(t);
    }
    if (lines.length >= 25) break;
  }
  if (lines.length === 0) {
    return '(no definitions matched)';
  }
  return lines.join('\n\n');
}

/** Python `_same_section`: both statements anchored in the same first-level section. */
function sameSection(
  doc: Document,
  a: TheoremEnvironment,
  b: TheoremEnvironment,
): boolean {
  const firstSection = (bid: string | undefined): string | undefined => {
    if (!bid) return undefined;
    for (const blk of doc.blocks) {
      if (blk.id === bid) {
        return blk.sectionPath.length > 0 ? blk.sectionPath[0] : undefined;
      }
    }
    return undefined;
  };
  const sa = firstSection(a.statementBlockId);
  const sb = firstSection(b.statementBlockId);
  return sa !== undefined && sa === sb;
}

/**
 * Python `_collect_symbols`: symbols worth tracking — math tokens,
 * subscripted names, latex commands surviving extraction.
 *
 * DOCUMENTED DIVERGENCE from Python: the Python source regex
 * `r"\\\\[A-Za-z]+"` (artifacts.py:177) means TWO literal backslashes, so
 * it matches nothing on realistic input like `\alpha` — effectively dead
 * code there (verified in the project venv). This port uses ONE backslash,
 * so `\alpha`-style latex tokens ARE collected. This changes overlap
 * counts for definitions packs on latex-heavy text — intentional:
 * the Python behavior is a latent bug, not a spec.
 */
function collectSymbols(text: string): Set<string> {
  const syms = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z](?:_[A-Za-z0-9]+)?\b/g)) {
    syms.add(m[0]);
  }
  for (const m of text.matchAll(/\\[A-Za-z]+/g)) {
    syms.add(m[0]);
  }
  return new Set([...syms].filter((s) => s.length <= 12));
}

/** Python `_overlap`: size of the intersection between symbols and text tokens. */
function overlap(symbols: Set<string>, text: string): number {
  const toks = new Set(text.match(/\b[A-Za-z](?:_[A-Za-z0-9]+)?\b|\\[A-Za-z]+/g));
  let n = 0;
  for (const s of symbols) {
    if (toks.has(s)) n += 1;
  }
  return n;
}
