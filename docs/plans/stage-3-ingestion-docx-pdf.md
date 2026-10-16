# Stage 3 — Heavy ingestion: PDF (pdf.js), DOCX (mammoth), artifacts

Branch: `stage/3-ingestion-docx-pdf` (off `main` @ `ea61e7c`, post-#2-merge).
Python reference: `src/open_referee/ingestion/{readers.py,artifacts.py}`,
`tests/test_ingestion.py`.

## Scope (per the 8-stage plan)

Port the remaining format readers + artifact extraction, all client-side:

1. **`src/ingestion/pdf.ts`** — pdf.js (`pdfjs-dist`) port of `_ingest_pdf`:
   per-page `get_text` → text lines; **figures** as `data:image/png` URLs
   (embedded image xrefs); **tables** via heuristic row-clusterer (owner
   decision 4: heuristic port only in v1 — pymupdf's `find_tables` has no
   JS equivalent); block→page mapping by proportional position (same
   formula).
2. **`src/ingestion/pdf_text.ts`** — `_pdf_text_to_markdown` heuristic
   (numbered/Appendix headings → `##`, paragraph joins). Pure string logic,
   port + tests first; this is where the Python tests bite.
3. **`src/ingestion/docx.ts`** — `mammoth.convertToMarkdown` (browser
   build) → `documentFromMarkdown(md, 'docx', stem)`. Trivial wrapper.
4. **`src/ingestion/artifacts.ts`** — port of `artifacts.py`:
   `extractTheorems` (theorem/proof pairing incl. QED absorption),
   `extractTables` (markdown pipe-table blocks → TableArtifacts with
   caption-window), `buildDefinitionsPack` (symbol-overlap heuristics).
   Pure logic, no deps.
5. **`src/ingestion/readers_md.ts`** — extend `ingestByExtension`:
   `.pdf`/`.docx` route to the new async readers (factory takes
   `ArrayBuffer`); `.tex` stays `UnsupportedFormatError` (owner plan:
   LaTeX dropped client-side — pylatexenc has no JS equivalent; document
   the divergence).
6. **UI wiring** — `app.ts` file input accepts `.pdf,.docx`; reads
   `ArrayBuffer` and calls the async ingest path; errorBox on
   unsupported/corrupt files (existing pattern).

## Constraints carried over

- Prompts/models untouched. No server. Bundle: pdf.js must be a **lazy
  chunk** (`import()`), mammoth likewise — measure `pnpm build` sizes.
- Tests: no real network; pdf.js tests use tiny generated PDFs (fixture
  bytes inline); mammoth tests use a minimal .docx fixture built via
  JSZip in-test or a committed binary fixture (prefer committed fixture +
  hash).
- `pnpm format && pnpm lint && pnpm typecheck && pnpm test` green before
  every commit; one conventional commit per module; subagents never push.

## Waves

- **Wave A (implementer):** pdf_text.ts + artifacts.ts (pure logic,
  Python-test parity) and docx.ts + pdf.ts wrappers + ingestByExtension +
  UI wiring + fixtures. Single wave acceptable — modules are
  independent; reviewer runs in parallel.
- **Review:** spec (behavioral parity with readers.py/artifacts.py +
  Python tests) + quality (pdf.js worker/main-thread choice, bundle size,
  memory: revoke data URLs? no — same as Python, keep in Document).
