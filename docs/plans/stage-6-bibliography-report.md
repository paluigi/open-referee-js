# Stage 6 — Bibliography audit + report UX (anchoring, print, resume)

Branch: `stage/6-bibliography-report` (off origin/main after PRs #5/#6
merge; until then branch off `stage/5-literature-scout` @ 85bb96a —
NOTE: PR #6 is also stacked on the Stage-4 branch; if the user merges
#5 and #6 in order, main carries everything and this branch may need a
rebase before PR. Sync-check at stage start).
Python reference: orchestrator.py `_bibliography` (L592-613),
`_extract_intext_citations` (L702-746), `_meta` (L615-630 — bib_summary
slot), `_assemble` anchor resolution (`_resolve_anchor`/`_section_of_block`
— find them and port), prompts.py BIBLIOGRAPHY_SYSTEM/USER (L314-351 —
ALREADY in TS prompts.ts, bibliographySystem char-verified IDENTICAL and
bibliographyPrompt exists; meta already has the bibSummary param, wired
as '' — fill it).

## Scope

1. **State machine** — add `'bibliography'` stage between challenge and
   meta (Python order: challenge → bibliography → meta → validate;
   TS currently challenge → meta). Old 8-stage runs keep loading.
2. **`src/pipeline/bibliography.ts`** —
   - `extractInTextCitations(doc, maxCitations=60)`: port the 4 regex
     patterns (author-year runs FIRST, numeric [1], parenthesized,
     natbib Smith2001), span-overlap dedupe, year-or-bracket filter,
     sentence context `[:400]`, `- cite :: claim` line format,
     `'(no in-text citations detected)'` fallback. CHAR-PARITY harness
     on the emitted string for a fixture with mixed citation styles.
   - `runBibliographyAudit({ callJson, doc, pack, settings })`:
     `referencesText[:30_000]` + intext `[:15_000]` +
     `renderPack(pack, 25)` → SMALL `callJson` with repair;
     `setdefault('in_text_issues', [])` equivalent; LLMError →
     `{ entries: [], in_text_issues: [], missing_key_references: [] }`
     (fail-soft, Python logs and continues). Budget → surface.
3. **Meta wiring** — `bibSummary = JSON.stringify({entries,
in_text_issues})[:8_000]` into the existing metaPrompt param
   (Python `_meta` L619-624).
4. **Report anchoring** — port `_resolve_anchor` + `_section_of_block`
   into the assemble step: comments get `blockId`,
   `anchorConfidence` ('exact'|'fuzzy'|'none' — read Python for the real
   scale), section title. Check what TS assemble currently does; if it
   already resolves anchors, diff against Python and close gaps.
   ReviewComment report type: add missing fields.
5. **Report UX** (exploration §3.5 / roadmap stage 6):
   - anchor links: comment cards scroll-to + highlight the referenced
     block in the manuscript pane (and back);
   - print-PDF: `@media print` stylesheet so the report prints clean
     (no app chrome, page breaks before sections);
   - resume UX: persisted runs list already exists (Stage 1) — surface
     in-progress runs with a Resume button that re-enters the generator
     at the first non-done stage (orchestrator `_stage_or_resume`
     semantics — verify how much already works; the state machine saves
     per-stage artifacts).
6. **Tests** — citation-extractor parity, audit fail-soft (LLMError →
   empty), budget propagation, meta bibSummary wiring (queue assertion),
   anchor resolution (exact/quote-fuzzy/miss), stage-order compat,
   resume e2e (kill after challenge, resume → completes without
   re-calling earlier stages), print stylesheet presence smoke.
7. **Docs** — README pipeline line + CHANGELOG Stage-6 entry.

## Constraints

- Gates before every commit; one conventional commit per module; never push.
- No new deps (print = CSS only; anchoring = DOM scrollIntoView).
- mergeSettings: no new settings expected this stage; if any appear,
  round-trip + test (standing rule).

## Waves

- **Wave A (single implementer):** bibliography module + state stage +
  meta wiring → anchoring port → report UX → tests → docs. Sequential
  (touches orchestrator throughout).
- **Reviewer** after: spec parity (citation extractor char-parity,
  bib audit contract, meta wiring, anchor resolution) + quality +
  resume-path stress.
