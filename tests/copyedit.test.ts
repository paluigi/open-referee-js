import { describe, expect, it } from 'vitest';
import {
  bibliographyPrompt,
  copyeditPrompt,
  copyeditSystem,
} from '../src/pipeline/prompts';
import { sanitizeCopyeditItems } from '../src/pipeline/copyedit';
import { Block, BlockType, Document } from '../src/ingestion/document';

// ===== Python-generated expected values (`uv run python` in the open-referee
// repo against prompts.COPYEDIT_SYSTEM / COPYEDIT_USER / BIBLIOGRAPHY_USER
// and orchestrator._copyedit; PY_* repr pattern from tests/prompts_claims.test.ts).

const PY_COPYEDIT_SYSTEM = `You are a meticulous copyeditor, not a referee. You receive a manuscript and list ONLY language-mechanics problems: typos, misspellings, grammar errors, awkward or ambiguous phrasing, and inconsistent terminology (the same concept called two different names in different places).

Rules:
- Every item must quote a span of the manuscript VERBATIM (<= 30 words, copied exactly — the quote will be mechanically located in the document; paraphrased quotes are useless).
- Provide a concrete suggested fix (the corrected or reworked phrase), not a description of the problem.
- kind is one of: typo | grammar | phrasing | terminology.
- At most 40 items, most useful first. Skip borderline cases; never pad.
- Do NOT comment on substance, mathematics, citations, structure, tone, or length — language mechanics only.

Return STRICT JSON: {"items": [{"quote": "...", "suggestion": "...", "kind": "typo|grammar|phrasing|terminology"}]}`;

const PY_COPYEDIT_USER = `Manuscript title: Test Paper

Manuscript (may be truncated):
----
# Test Paper

Some text.
----

List the language-mechanics fixes now. JSON only.`;

const PY_BIBLIOGRAPHY_USER = `Bibliography section (raw):
---
[1] Smith, J. (2001). A paper. Journal of Papers.
---

In-text citation mentions found in the manuscript (claim context may be truncated):
---
- Smith (2001) :: We build on Smith (2001)
---

Deterministic DOI resolution (Crossref/OpenAlex ground truth; MATCHED records
name the real work behind an entry — an entry you would call not_found despite
a MATCH here is mis-parsed, not phantom; UNMATCHED entries found no record and
are the phantom candidates):
---
- MATCHED 10.1/x :: A paper (Journal of Papers, 2001) [score 0.9]
---

Context pack:
---
# Field context pack (paper: Test Paper)
---`;

// --------------------------------------------------------------- prompts --

describe('copyedit prompts (char-parity with Python)', () => {
  it('copyeditSystem is char-identical', () => {
    expect(copyeditSystem).toBe(PY_COPYEDIT_SYSTEM);
  });

  it('copyeditPrompt is char-identical (via .format instantiation)', () => {
    expect(copyeditPrompt('Test Paper', '# Test Paper\n\nSome text.')).toBe(
      PY_COPYEDIT_USER,
    );
  });

  it('bibliographyPrompt carries the new {resolution} slot char-identically', () => {
    expect(
      bibliographyPrompt(
        '[1] Smith, J. (2001). A paper. Journal of Papers.',
        '- Smith (2001) :: We build on Smith (2001)',
        '- MATCHED 10.1/x :: A paper (Journal of Papers, 2001) [score 0.9]',
        '# Field context pack (paper: Test Paper)',
      ),
    ).toBe(PY_BIBLIOGRAPHY_USER);
  });
});

// ------------------------------------------------------------- sanitation --

function makeDoc(): Document {
  return new Document({
    title: 'T',
    blocks: [
      new Block({
        id: 'b1',
        type: BlockType.PARAGRAPH,
        text: 'The estimator uses a two-stage procedure with clustering. Standard errors are computed by bootstrap with 999 replications.',
        sectionPath: ['Methods'],
      }),
      new Block({
        id: 'b2',
        type: BlockType.PARAGRAPH,
        text: 'We conclude that the theorem holds in this setting.',
        sectionPath: ['Conclusion'],
      }),
    ],
  });
}

describe('sanitizeCopyeditItems (port of Python _copyedit tail)', () => {
  it('keeps well-formed items with kind lowercased and section stamped', () => {
    const items = sanitizeCopyeditItems(
      [
        {
          quote: 'Standard errors are computed by bootstrap',
          suggestion: 'Standard errors are computed via the bootstrap',
          kind: 'Phrasing',
        },
      ],
      makeDoc(),
    );
    expect(items).toEqual([
      {
        quote: 'Standard errors are computed by bootstrap',
        suggestion: 'Standard errors are computed via the bootstrap',
        kind: 'phrasing',
        section: 'Methods',
      },
    ]);
  });

  it('drops a non-whitelisted kind (after lowercasing)', () => {
    const items = sanitizeCopyeditItems(
      [
        {
          quote: 'two-stage procedure',
          suggestion: '2-stage procedure',
          kind: 'style',
        },
        { quote: 'with clustering', suggestion: 'via clustering', kind: 'TYPO' },
      ],
      makeDoc(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('typo');
  });

  it('drops items with empty quote or suggestion (incl. whitespace-only)', () => {
    const items = sanitizeCopyeditItems(
      [
        { quote: '', suggestion: 'x', kind: 'typo' },
        { quote: 'two-stage procedure', suggestion: '   ', kind: 'typo' },
        { quote: 'with clustering', suggestion: 'via clustering', kind: 'typo' },
      ],
      makeDoc(),
    );
    expect(items).toHaveLength(1);
  });

  it('drops non-dict entries', () => {
    const items = sanitizeCopyeditItems(
      [
        'nope',
        42,
        null,
        { quote: 'with clustering', suggestion: 'via clustering', kind: 'typo' },
      ],
      makeDoc(),
    );
    expect(items).toHaveLength(1);
  });

  it('drops items whose quote cannot be located in the document (anchor guard)', () => {
    const items = sanitizeCopyeditItems(
      [
        {
          quote: 'this sentence appears nowhere in the manuscript at all',
          suggestion: 'irrelevant',
          kind: 'typo',
        },
      ],
      makeDoc(),
    );
    expect(items).toEqual([]);
  });

  it('caps output at 40 items', () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({
      quote: 'two-stage procedure',
      suggestion: `fix number ${i}`,
      kind: 'typo',
    }));
    expect(sanitizeCopyeditItems(raw, makeDoc())).toHaveLength(40);
  });

  it('truncates quote and suggestion to 300 chars', () => {
    // Quotes are matched by normalized containment, so keep the quote a
    // real substring repeated past 300 chars; storage then truncates both
    // fields to 300 (Python `quote[:300]`).
    const blockText = 'The estimator uses a two-stage procedure with clustering.';
    const long = Array.from({ length: 8 }, () => blockText).join(' ');
    expect(long.length).toBeGreaterThan(300);
    const items = sanitizeCopyeditItems(
      [{ quote: long, suggestion: long, kind: 'typo' }],
      makeDoc(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.quote).toHaveLength(300);
    expect(items[0]!.suggestion).toHaveLength(300);
  });

  it('non-array raw value yields []', () => {
    expect(sanitizeCopyeditItems(undefined, makeDoc())).toEqual([]);
    expect(sanitizeCopyeditItems({ items: [] }, makeDoc())).toEqual([]);
  });
});
