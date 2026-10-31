# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning starts at 0.x until the Stage-8 release.

### Stage 7R — review-fix pass (7d/7e/7f findings)

- **Checker findings assemble-only** (upstream e2ba304, reverting the 7f
  merge): deterministic checker findings no longer ride the meta merge or
  the validate stream — the merger's dedup dissolved 28 deterministic
  findings into one prose comment in a real-world run (RMI). They are
  prepended fresh at assemble, provenance intact. Validate runs only when
  LLM candidates exist (no checker-only screening pass).
- **Wrap-up on infeasible plans** (7e review B4): when no continuation
  plan is feasible at a replan checkpoint, the run records
  `shortfallUsd` on the run state, marks never-started stages skipped,
  and assembles the partial wrap-up report (report cleared for the
  resumable top-up, mirroring the budget drain). Challenge and verify
  replan checkpoints run regardless of whether a decision model is
  bound; three verify sub-stage checkpoints (`verify/claims`, lenses,
  artifacts) anchor Python's mid-stage replans.
- **Committee ranking honored** (7e B2): claim verification keeps the
  committee's importance order instead of re-sorting by coarse
  importance (`n_claims` also feeds the budget stats before planning).
- **Decision provider wired in the UI** (7e B6): a bound `decisionRole`
  now constructs the decision provider and threads it into `runReview`
  (fresh + resume); a missing pricing block degrades to zero pricing
  instead of crashing. Strategy reflection propagates budget trips.
- **Reasoning capability config** (7d review C1): `supportsReasoning`
  is settable per role in settings (`roles.<role>.supportsReasoning`,
  universal boolean-only rule) and reaches the provider construction —
  previously it existed only as a provider class flag. Note: Python's
  `llm.json_two_phase` `'always'/'never'` modes remain unported (auto
  detection only).
- **Two-phase repair fallthrough** (7d C2): an `LLMError` inside the
  two-phase arms now falls through to the single repair replay (Python
  try/except parity) instead of failing the call.
- **Minor parity fixes** (7f review): `n_lenses` recorded on budget
  stats; lean-finish residual no longer forces `synthesis: false`
  (matches upstream `residual_frontier`); a synthesis budget trip now
  drains the run like every other stage instead of degrading silently.

### Stage 7f — yield upgrades: checker findings merge, synthesis, wider gates

- **Checker findings join the meta + validator streams** (449174c):
  deterministic/recompute findings ride the comment stream into the meta
  merger (provenance preserved) and into validate — they skipped the
  defense gate by construction, so validate is their only LLM screening;
  assemble dedupes so no finding appears twice.
- **Synthesis pass**: a lead-referee essay (4-6 argued themes over the
  deduplicated comments) replaces the merger's overall feedback. Gated
  on the synthesis knob (off on min-viable/lean plans) and the budget
  affordance gate; priced and output-budgeted; fail-soft.
- **New lenses**: stats (statistical rigor, empirical papers) and
  clarity (technical ambiguity, always on) — verbatim prompt parity.
- **Defense second round**: deep plans (`defenseSecondRound`) re-run the
  whole defense/adjudication gate over the survivors; planning counts
  doubled when enabled.

### Stage 7e — decision models, committee planning, batched dm_defense

- **Decision-model layer** (upstream b04cf21/eaa1a85): a `decision`
  provider type speaking the `/v1/decisions` predicate/choice/score API
  with typed answers + distributions, usage booked in the ledger, a
  `FakeDecisionProvider` for tests, and an **optional** `decisionRole`
  setting — absent means the DM layer is fully dormant and every stage
  keeps its labelled-LLM fallback with byte-identical call sequences.
- **Batched dm_defense** (4132423): verdict questions run
  `DM_BATCH_COMMENTS = 40` comments per decide() call with the anchored
  manuscript passage next to each defense; a per-batch failure upholds
  only that batch; the budget learns `dm_defense`
  (ceil(comments/40) calls, doubled on a second defense round).
- **Committee planning** (auto mode): a ~10-point feasible-by-
  construction frontier over depth × breadth; the strong LLM reflects
  (no commit authority, never sums costs), the DM chooses a frontier
  path and confirms it; a rejected confirmation triggers exactly one
  more DM round that commits unconditionally. Replanning checkpoints
  (stages, verify sub-stages, spike detection ≥8x) rebuild a residual
  frontier from residual budget; single-option repairs apply with no
  call; low-confidence DM choices escalate to one LLM consultation.
  Nothing feasible mid-run wraps up an incomplete report with the
  shortfall recorded (resumable drain, no exception through the UI).

### Stage 7d — two-phase JSON, prompt A/B winners, robustness

- **Two-phase JSON for reasoning models** (upstream 1515a7d/8a8bb77/
  bfd2cdb): providers can declare `supportsReasoning` (default false);
  reasoning models run a phase-1 reasoning pass at a 24k budget, then a
  phase-2 JSON emission with the reasoning in context, with a
  low-effort emission retry before the free-form fallback. The call
  ladder (parse → retry → two-phase → one repair replay → `LLMError`)
  lives in the orchestrator's `callJson`; `callJsonWithRepair` forwards.
  Non-reasoning stubs are byte-for-byte unaffected (e2e queues pinned).
- **Prompt A/B winners** (60d7779): inventory-coverage duties,
  figure-text PAIR contract, META preservation contract, challenger
  provenance-echo lines, evidence-based validator DROP contract — all
  char-parity-pinned against origin/main `prompts.py`.
- **Evidence-based validator gates + provenance re-attachment**
  (9a40f13): `_reattach_provenance` port (quote > anchor >
  difflib-similarity ≥ 0.6 tiers, never overwrites); the meta
  comments-listing input cap scales as `max(100_000, 900·n)`.
- **Robustness** (fe463f2, 61f5822, c628796, 814c895, e5eedfa, 7949c40,
  ed1d8da, 81f5a61): bare-list JSON envelopes tolerated; non-dict items
  skipped; JSON-repair failure raises `LLMError`; retry logging via a
  collectible `setRetryLogger` sink (model, attempt, error, backoff);
  HTML-anchored headings + heading-heuristic fallback in sectioning;
  OpenAlex/Crossref polite-pool `mailto=` with an email env ladder;
  ContextPack rebuilt from its persisted artifact on resume; challengers
  respect the budget affordance gate (pass through unvalidated, gate
  stops noted, defense tail still runs).

### Stage 7c — budget core (cost model, deterministic planner, per-phase spend)

- **Full port of `pipeline/budget.py`** (`src/pipeline/budget.ts`): the
  cost model (per-call-type input estimates at 3 chars/token, per-tier
  output budgets `callMaxTokens(callType, outLevel)`, pricing-table
  arithmetic with Python `round(x, 6)` semantics via exact `pyRound`),
  the deterministic planner (doc-stats → knobs/estimates ladder —
  same doc + tier always yields the same plan; preset USD figures port
  UNCHANGED per owner decision), the per-phase spend harness fed by
  every booked call record (empirical unit costs, done counters, spike
  detection, gate-stop registry), budget-driven steering with repair
  options, and the wrap-up reserve.
- **Settings block** `budget` (depth tier + hard `maxCostUsd`):
  `mergeSettings` round-trips it; the UI settings fieldset gains the
  tier selector, a projected-cost estimate, spend-so-far in the
  progress panel, and a top-up affordance on a drained run.
- **Gate wiring** (closes the two documented divergences):
  `planKnobs.copyedit` + `harness.allow_call('copyedit')` gate the
  copyedit stage (7a "always-on" divergence closed — knob off emits
  `skipped` with no call, an open gate-stop is recorded like Python's
  `note_gate_stop`); the meta call's max output tokens scales as
  `max(callMaxTokens('meta', level), min(32_768, 2_000 + 130·n))`
  (7a "not scaled" divergence closed). Depth presets now flow from the
  budget tier (`depthPresetFromTier`) with user overrides still winning.
- **Resumable top-up**: a budget drain mid-run persists the doc
  snapshot + plan + ledger on RunState, wraps up a partial report for
  the UI, and clears the persisted report so the resume gate re-enters
  every not-completed stage; raising the cap and resuming completes the
  run without re-calling completed stages (e2e-pinned in
  `tests/pipeline_budget_e2e.test.ts`).

### Stage 7b — deterministic checkers (cross-refs, number consistency, table arithmetic)

- **New deterministic checkers pass** (`src/pipeline/checkers.ts`, full port
  of Python `pipeline/checkers.py`): runs at the verify head BEFORE the
  claim workers, zero LLM cost. `crossReferenceCheck` (duplicate labels,
  dangling figure/table/theorem/equation/section references aggregated per
  class+label with ±110-char quote windows, orphan classes, non-monotone
  numbering, missing-section registry; cap 8 findings),
  `numberConsistencyCheck` (abstract-vs-body conflicts of the same named
  quantity — last-two-content-words template matching, years/DOIs/LaTeX/
  plain-integer/generic-tail exclusions, `0.6·10^-minDec` + 1%-relative
  tolerances), and `tableArithmeticCheck` (total-row column sums and
  row-total mismatches with paren-negative/comma/%/unicode-minus parsing,
  separator-row detection, share/sum column exclusion). All regexes and
  outputs parity-pinned against Python (`uv run` harness: fixture documents
  - `f"{x:g}"` formatter incl. round-half-even ties + per-regex findall/
    span probes; 388-double %g stress all green).
- **Orchestrator wiring**: verify stage runs `runDeterministicChecks` only
  when `state.checkerFindings` is empty (Python `if not
self.state.checker_findings` — doi-resolution findings from the
  bibliography stage share the array and suppress the scan, exactly as in
  Python); findings persist to RunState BEFORE the verify-done emit; the
  run emits `deterministic checks: consistency×1, xref×2` (sorted kinds).
  `extractTheorems`/`extractTables` now run at pipeline start (Python
  post-ingest point) so the checkers see theorem/table artifacts.
- **Report**: checker findings JOIN the report at assemble as comments
  (`checkerComments`: severity clamped [0.1, 0.95], title/message/quote
  truncation 160/2500/240, provenance kept), anchored like validator
  comments with combined `c{i:03d}` numbering. `render_markdown` port
  updated to Python `_comment_header` (`### {i}. {title} — _{section}_` +
  `_[severity 0.35] · [reference] · [deterministic]_` tag line) with the
  Findings / `## Deterministic checks (N)` split (`_DETERMINISTIC_
PROVENANCE = ('deterministic','recompute')`) and both italic preambles
  verbatim. `ReviewComment` gains optional `title`.
- `checkers.test.ts` (19 tests) + pipeline e2e extensions: findings appear
  as deterministic comments in the report; resume with findings present
  skips the scan (no second `deterministic checks:` emit); pre-seeded
  doi findings suppress the scan (the Python vice-versa coupling).

### Stage 7a — copyedit annex + deterministic reference resolution

- **New copyedit stage** (`… → validate → copyedit → assemble`, Python 9b
  `_copyedit` port): one SMALL-role pass listing language-mechanics fixes
  (typo | grammar | phrasing | terminology). Items are sanitized exactly
  like Python: verbatim-quote requirement enforced by the deterministic
  anchor resolver (quotes that cannot be located in the manuscript are
  DROPPED — hallucination guard), 300-char truncation, cap 40, section
  stamped from the resolved block. Fail-soft: an LLM/parse failure yields
  no items and never blocks the report; only a budget cap surfaces. The
  `copyeditItems` artifact persists **before** the done event, so resume
  never re-calls the stage. Old runs without the stage keep loading.
  _Documented divergence (CLOSED in 7c):_ Python gates the stage on
  `plan_knobs().copyedit` and `budget_allows('copyedit')` (budget
  harness); both gates are wired now (see Stage 7c).
- **Deterministic DOI resolution** (Python `_resolve_references` +
  `literature/reference_resolution.py` port): before the bibliography audit,
  every bibliography entry is looked up on Crossref + OpenAlex (concurrency
  4, per-call fail-soft, 60s overall timeout → all-unmatched records) and
  scored against the entry's probable title with a faithful
  `difflib.SequenceMatcher.ratio()` port (`max(ratio, whole*0.9)`, matched
  iff ≥ 0.72). Records memoize on RunState (`doiResolutions`, persisted
  before the audit), render into the bibliography prompt's new
  `{resolution}` slot (Python `BIBLIOGRAPHY_USER` parity, machine-verified),
  and the first 20 unmatched entries become deterministic
  `doi-resolution` checker findings on RunState (not report comments yet —
  the full checkers land in 7b). Zero LLM cost; network clients are
  injected, so tests stay offline.
- **Report**: optional `copyeditItems` render as the Python
  `Suggested language fixes (N)` table (pipe/newline cells escaped,
  `—` section fallback); comments carry optional `provenance`.
- `reference_resolution` parity harness (uv-run Python reprs pinned in
  tests): 26 SequenceMatcher pairs, 10 splitReferences fixtures,
  5 titleGuess/norm/queryFor entries, 35 scores, 3 renderResolutions
  outputs; copyedit + bibliography prompts char-identical.

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
