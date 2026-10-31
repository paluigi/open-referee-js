# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning starts at 0.x until the Stage-8 release.

## [0.1.0] — 2026-10-16

Stage 1 skeleton of the static client-side TS port of
[open-referee](https://github.com/paluigi/open-referee).

### Stage 6 — bibliography audit + report UX

- **New bibliography stage** (`… → challenge → bibliography → meta → …`,
  Python `_bibliography` port): in-text citations are extracted with a
  char-parity port of `_extract_intext_citations` (author-year, numeric
  `[1]`, parenthesized, and natbib `Smith2001` patterns in priority
  order; span-overlap dedupe; sentence claim context `[:400]`; the
  `(no in-text citations detected)` fallback) and audited by a SMALL-role
  LLM call against `referencesText[:30_000]` and the context pack
  (`renderPack` 25 items). Fail-soft like Python: an LLM/parse failure
  yields the empty audit and the run continues; only a budget cap
  surfaces. Old runs without the stage keep loading.
- **Meta-review wiring**: `bib_summary = json({entries, in_text_issues})
[:8_000]` now fills the metaPrompt's citation-audit slot (Python
  `_meta` parity).
- **Anchor resolution** (Python `_resolve_anchor` / `_section_of_block`
  port): assembled comments carry `id`, `blockId`, `anchorConfidence`
  (exact 1.0 / multi-hit 0.7 / quote 0.6 / token-overlap Jaccard > 0.35)
  and the block's section.
- **Report UX**: comment cards with a resolved block anchor to the
  manuscript pane (scroll + highlight, plus a back link); `@media print`
  stylesheet hides all app chrome, prints the manuscript inline, and
  breaks pages before report sections; in-progress runs are listed with
  a **Resume** button that re-enters the pipeline at the first non-done
  stage (per-stage artifacts — triage/claims/survey/challenge/
  bibliography — and a document snapshot persist in the run state, so
  completed stages are never re-called).

### Stage 5 — literature grounding + community scout

- **Survey stage is now the real literature pack** (Python `_literature`
  port): OpenAlex work search per triage `search_query` (until 30 items),
  web-router context via Tavily/TinyFish in `settings.searchOrder`
  (deduped by normalized title), then a SMALL-role surveyor LLM call
  (char-parity `surveySystem`) maps `why_relevant` onto selected pack
  items, pulls `missing_references` through Crossref, and folds
  `state_of_the_art_notes` into the field hint.
- **New scout stage** (`triage → claims → survey → scout → verify → …`):
  PeerReviewScout scans pubpeer.com / openreview.net / prereview.org for
  prior discussion of the paper and its top 6 key citations; findings
  extend the context pack. The pack is stored in `artifacts.survey` for
  resume and feeds the meta-review (SOTA notes).
- **Fail-soft everywhere in the literature path**: dead APIs, HTTP errors,
  and CORS blocks (fetch TypeError) degrade to `console.warn` + empty
  results — a scout source that fails its first probe is dropped for the
  run after one warning. LLM/budget errors from the surveyor still fail
  the stage (Python parity).
- **OpenAlex REST client** with `abstract_inverted_index` reconstruction
  and `api_key`/`mailto` params; **Crossref client** joins the polite pool
  via the `mailto` query param (browsers forbid the User-Agent header —
  documented divergence).
- **Search keys** (`tavily`, `tinyfish`) are session-only settings inputs;
  `mergeSettings` round-trips the block and persistence strips it.
- Old persisted runs without the scout stage keep loading (`stages` is
  Partial; scout reads back as pending).
- Deferred (documented): Python's user-supplied literature path
  (`pack.user_docs` from author PDFs + `source='user_pdf'` OpenAlex
  matching) — the browser app has no multi-document ingest yet; the
  `renderPack` user-docs line stays for parity but is empty (Stage 6+).
  Scout `search_queries` capped at 8 and triage `search_queries` consumed
  up to 8 per Python `run()`.

### Stage 4 — verification engine (claims, lenses, defense gate)

- **Claim inventory**: the strong model decomposes the manuscript into
  atomic checkable claims (theorem/proof, equation, numerical, table/text,
  figure/text, citation, cross-reference, assumption-use, logical) with
  importance ordering and sanitation.
- **Typed per-claim verification workers** under a bounded concurrency pool
  (Python `max_parallel_calls`): strong re-derives math, small checks
  numbers/tables/citations; per-claim definitions packs from the Stage-3
  artifacts module; per-claim progress events.
- **Section verifier lenses** selected from triage (prose / math /
  empirical / literature) + whole-paper coherence pass, both depth-preset
  controlled (`review` settings block, additive).
- **Defense–adjudication quality gate**: a small model argues the strongest
  honest authors' defense per candidate comment, a strong model adjudicates
  (upheld / adjusted / dismissed); gate failures never drop comments.
- **JSON-repair retry** on worker calls (Python RolePool parity); budget
  exhaustion mid-pool drains gracefully into a partial report.
- Artifact **vision** passes are stubbed (return no comments) until
  `ChatMessage` gains image support (Stage 5+); `findMentions`/
  `nearPageBlocks` are ported and tested ahead of that.
- Deviations from Python documented in code: artifact vision deferred. The
  defense gate runs at the challenge tail, matching Python's placement at
  the end of `_challenge` (its output feeds meta/validate).

## Stage 3 — heavy ingestion (PDF, DOCX, artifacts)

- **PDF** via pdf.js (lazy chunk): text extraction with pymupdf-style line
  joining, `_pdf_text_to_markdown` heading/paragraph heuristics (byte-
  identical regexes), proportional block→page mapping, heuristic table
  clusterer (x/y alignment) with Python-parity markdown escaping. Figures
  deferred (v2); tables are heuristic-only per owner decision 4.
- **DOCX** via mammoth (lazy chunk) → markdown → canonical Document.
- **Artifacts module** (`artifacts.py` port): theorem/proof pairing with
  QED absorption, markdown pipe-table extraction with caption window,
  definitions pack with symbol-overlap matching.
- **Async ingest dispatch**: `.pdf`/`.docx`/`.md`/`.txt` from the UI file
  picker; `.tex` rejected with guidance (no browser LaTeX converter).
- Deviations from Python documented in code: figures=[], single-backslash
  latex-symbol collection (Python's double-backslash variant is dead code),
  pdf.js worker wired for the browser (Node tests use the fake-worker
  fallback).

## Stage 2 — full providers, secrets vault, settings UI

- Provider factory (`createProvider`) mapping all six provider types with
  Python-parity validation errors; **Anthropic** adapter (browser-direct-
  access header, `2023-06-01` version pin), **Gemini** adapter
  (`x-goog-api-key` header — keys never in URLs), **Ollama** native
  `/api/chat` adapter (no auth, per-baseUrl rate limiting); vLLM reuses the
  OpenAI-compatible adapter.
- Shared `retryFetch` helper: one retry contract (429/5xx/network,
  exponential backoff, `Retry-After`) enforced across all adapters.
- **Secrets vault**: opt-in passphrase-encrypted key storage — PBKDF2-SHA256
  (310k iters) → AES-GCM 256, per-vault salt, fresh IV per write; session-only
  in-memory keys remain the default; vault locks on page unload; corrupted
  payloads and wrong passphrases surface as typed `VaultError`s.
- **Settings UI v2**: named provider manager (add/remove/inline baseUrl edit),
  strong/small/vision role bindings, vault controls (set passphrase, unlock,
  lock, state indicator); removing a provider drops its vault secret and
  clears stale role bindings; API keys never reach `localStorage`.

## Stage 1

### Added

- Vite + vanilla TypeScript project (strict mode), Vitest suite (happy-dom),
  ESLint flat config + Prettier, GitHub Actions CI (lint, typecheck, test,
  build).
- Typed settings schema with deep-merge `localStorage` persistence; API keys
  are stripped on save (session-only secrets until the Stage-2 vault).
- Provider layer: base contracts, scripted `FakeProvider` test double,
  OpenAI-compatible `fetch` adapter (retry with exponential backoff,
  `Retry-After` both seconds and HTTP-date, machine-readable `LLMError.status`),
  **min-delay rate limiter** (per-provider, concurrency-safe), and a
  `UsageLedger` with cost estimation and a `BudgetExceeded` spend cap.
- Ingestion: `Document`/`Section`/`Block` model with NFKC text normalization
  and content hashing (pure-JS SHA-256, verified against Python vectors),
  markdown reader with the upstream regexes ported exactly.
- Prompts ported **verbatim** from the Python referee (25/25 strings
  character-identical), including persona, severity rubric, and comment schema.
- Pipeline: `RunState` stage machine (triage → survey → challenge → meta →
  validate → assemble) with an append-only event log; robust JSON extraction
  from LLM responses; orchestrator implemented as an async generator with
  per-section progress, budget drain into a **partial report**, graceful stage
  failure, and crash recovery (an unexpected error persists a failed run
  instead of leaving it running); IndexedDB persistence of runs + events.
- Report model + markdown renderer mirroring the Python output; UI app shell
  with settings panel, markdown file ingest, **progress bar** (determinate
  per-section, indeterminate otherwise) with stage checklist, sanitized
  report view (marked + DOMPurify), and `.md` download.
