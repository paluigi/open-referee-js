# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning starts at 0.x until the Stage-8 release.

## [0.1.0] — 2026-10-16

Stage 1 skeleton of the static client-side TS port of
[open-referee](https://github.com/paluigi/open-referee).

### Stage 3 — heavy ingestion (PDF, DOCX, artifacts)

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
