/**
 * Faithful port of Python `difflib.SequenceMatcher(None, a, b).ratio()`.
 *
 * Only the autojunk-free (junk=none) path is ported: the reference-resolution
 * scorer constructs `SequenceMatcher(None, a, b)` exactly like this. The
 * algorithm mirrors CPython `difflib.py`: `find_longest_match` builds a `b2j`
 * map (every index in b where a given char occurs), extends matches over
 * adjacent equal elements, and recurses on the regions before and after the
 * longest match; `ratio()` is `2*M / (len(a)+len(b))` over the matching
 * blocks, memoized like Python's `.ratio()` cache.
 *
 * Char-level: JS strings are iterated by UTF-16 code unit, matching Python's
 * behavior on the BMP characters that feed title matching.
 */

interface MatchBlock {
  /** a-index where the block starts. */
  a: number;
  /** b-index where the block starts. */
  b: number;
  /** block length. */
  size: number;
}

export class SequenceMatcher {
  private readonly a: string[];
  private readonly b: string[];
  /** char -> ascending b-indices (Python b2j with junk=none). */
  private readonly b2j: Map<string, number[]>;
  /** Python autojunk: popular elements (>1% of b when len(b) >= 200). */
  private readonly bpopular: Set<string>;
  private blocks: MatchBlock[] | null = null;
  private ratioCache: number | null = null;

  constructor(a: string, b: string) {
    this.a = Array.from(a);
    this.b = Array.from(b);
    this.b2j = new Map();
    for (let j = 0; j < this.b.length; j++) {
      const ch = this.b[j]!;
      const idx = this.b2j.get(ch);
      if (idx === undefined) this.b2j.set(ch, [j]);
      else idx.push(j);
    }
    // Python autojunk (default ON in SequenceMatcher(None, a, b)): for
    // len(b) >= 200, elements occurring on >1% of positions are "popular"
    // and drop out of b2j. find_longest_match won't seed a match on them,
    // but may still EXTEND across them (CPython difflib parity).
    this.bpopular = new Set();
    const n = this.b.length;
    if (n >= 200) {
      const threshold = Math.trunc(n / 100) + 1;
      for (const [ch, idx] of this.b2j) {
        if (idx.length > threshold) {
          this.bpopular.add(ch);
          this.b2j.delete(ch);
        }
      }
    }
  }

  /**
   * Python `find_longest_match(alo, ahi, blo, bhi)`: longest block in
   * a[alo:ahi] vs b[blo:bhi], ties resolved to the earliest (i, j).
   */
  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): MatchBlock {
    // Jones's O(nm) extension sweep, verbatim from CPython difflib.
    const b2j = this.b2j;
    let besti2 = alo;
    let bestj2 = blo;
    let bestsize = 0;
    const j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(this.a[i]!) ?? [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti2 = i - k + 1;
          bestj2 = j - k + 1;
          bestsize = k;
        }
      }
      j2len.clear();
      for (const [j, len] of newj2len) j2len.set(j, len);
    }
    // Extend over adjacent equal elements (Python's "not on the edges"
    // extension), again verbatim.
    let ai = besti2;
    let bj = bestj2;
    let size = bestsize;
    while (ai > alo && bj > blo && this.a[ai - 1] === this.b[bj - 1]) {
      ai--;
      bj--;
      size++;
    }
    while (
      ai + size < ahi &&
      bj + size < bhi &&
      this.a[ai + size] === this.b[bj + size]
    ) {
      size++;
    }
    return { a: ai, b: bj, size };
  }

  /** Python `get_matching_blocks`: non-adjacent ascending matching blocks. */
  getMatchingBlocks(): MatchBlock[] {
    if (this.blocks !== null) return this.blocks;
    const queue: [number, number, number, number][] = [
      [0, this.a.length, 0, this.b.length],
    ];
    const matched: MatchBlock[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const m = this.findLongestMatch(alo, ahi, blo, bhi);
      if (m.size > 0) {
        matched.push(m);
        if (m.a > alo && m.b > blo) queue.push([alo, m.a, blo, m.b]);
        if (m.a + m.size < ahi && m.b + m.size < bhi) {
          queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
        }
      }
    }
    matched.sort((x, y) => x.a - y.a || x.b - y.b || x.size - y.size);
    // Merge adjacent blocks (Python's adjacency collapse).
    const blocks: MatchBlock[] = [];
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    for (const m of matched) {
      if (i1 + k1 === m.a && j1 + k1 === m.b) {
        k1 += m.size;
      } else {
        if (k1 > 0) blocks.push({ a: i1, b: j1, size: k1 });
        i1 = m.a;
        j1 = m.b;
        k1 = m.size;
      }
    }
    if (k1 > 0) blocks.push({ a: i1, b: j1, size: k1 });
    blocks.push({ a: this.a.length, b: this.b.length, size: 0 });
    this.blocks = blocks;
    return blocks;
  }

  /** Python `ratio()`: 2*M / (len(a)+len(b)), memoized. */
  ratio(): number {
    if (this.ratioCache !== null) return this.ratioCache;
    let matches = 0;
    for (const b of this.getMatchingBlocks()) matches += b.size;
    const la = this.a.length;
    const lb = this.b.length;
    this.ratioCache = la + lb > 0 ? (2 * matches) / (la + lb) : 1.0;
    return this.ratioCache;
  }
}

/** Python `difflib.SequenceMatcher(None, a, b).ratio()` convenience. */
export function similarityRatio(a: string, b: string): number {
  return new SequenceMatcher(a, b).ratio();
}
