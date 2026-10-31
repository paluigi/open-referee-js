import { describe, expect, it } from 'vitest';
import { extractInTextCitations } from '../src/pipeline/bibliography';
import { Block, Document } from '../src/ingestion/document';

// ===== Python-generated expected values (`uv run python` in the open-referee
// repo against orchestrator._extract_intext_citations; PY_* pattern from
// tests/prompts_claims.test.ts). Parity is char-for-char on the emitted
// `- cite :: claim` string.

const FIXTURE = `As shown by Smith (2001), the effect is robust. Earlier work (Smith and Jones, 2001; Doe, 2019) disagreed.
The model in [1] differs from [2, 3] and the range [4-6]. We follow Jones2020 here.
Miller et al. (1999) prove uniqueness. A reference to Smith2001 appears in natbib output.
This sentence has no citations at all.`;

const PY_FIXTURE_OUTPUT = `- Smith (2001) :: As shown by Smith (2001), the effect is robust
- [1] :: Earlier work (Smith and Jones, 2001; Doe, 2019) disagreed. The model in [1] differs from [2, 3] and the range [4-6]
- [2, 3] :: Earlier work (Smith and Jones, 2001; Doe, 2019) disagreed. The model in [1] differs from [2, 3] and the range [4-6]
- [4-6] :: Earlier work (Smith and Jones, 2001; Doe, 2019) disagreed. The model in [1] differs from [2, 3] and the range [4-6]
- (Smith and Jones, 2001; Doe, 2019) :: Earlier work (Smith and Jones, 2001; Doe, 2019) disagreed. The model in [1] differs from [2, 3] and the range [4-6]
- (1999) :: (1999) prove uniqueness
- Jones2020 :: We follow Jones2020 here. Miller et al
- Smith2001 :: A reference to Smith2001 appears in natbib output. This sentence has no citations at all.`;

const PY_EMPTY_OUTPUT = '(no in-text citations detected)';

const BIG = Array.from(
  { length: 10 },
  (_, i) => `Case ${i} cites Author (20${String(i).padStart(2, '0')}) often.`,
).join(' ');

const PY_BOUND_OUTPUT = `- Author (2000) :: Case 0 cites Author (2000) often
- Author (2001) :: Case 1 cites Author (2001) often
- Author (2002) :: Case 2 cites Author (2002) often`;

function docWith(text: string): Document {
  return new Document({ blocks: [new Block({ id: 'b1', text })] });
}

describe('extractInTextCitations (char-parity with Python)', () => {
  it('reproduces the Python output on a mixed-style fixture', () => {
    expect(extractInTextCitations(docWith(FIXTURE))).toBe(PY_FIXTURE_OUTPUT);
  });

  it('falls back to the Python no-citations sentinel', () => {
    expect(extractInTextCitations(docWith('Nothing to cite here, move along.'))).toBe(
      PY_EMPTY_OUTPUT,
    );
  });

  it('honours maxCitations like Python', () => {
    expect(extractInTextCitations(docWith(BIG), 3)).toBe(PY_BOUND_OUTPUT);
  });

  it('span-overlap dedupe: author-year claims the span before bare-paren', () => {
    const out = extractInTextCitations(docWith('Smith (2001) showed it.'));
    // Exactly one hit, and the cite keeps the full "Smith (2001)" span.
    expect(out).toBe('- Smith (2001) :: Smith (2001) showed it.');
  });
});
