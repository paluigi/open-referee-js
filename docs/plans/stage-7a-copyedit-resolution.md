# Stage 7a — copyedit annex + deterministic reference resolution

Catch-up stage: port the two smallest post-Stage-6 upstream systems
(Python `b72f55e..26ae883`). Branch `stage/7a-copyedit-resolution` off
`origin/main` (783be53). PR will stack on PR #7 (`stage/6-bibliography-report`)
— since the user merges in bulk, branch content comes from `origin/main`
plus a content-merge of the Stage-6 branch (identical rule to Stages 5/6:
bring prior stage content in FIRST, before any wave dispatch).

## Scope (from Python origin/main = 26ae883)

### 1. copyedit stage (`_copyedit`, prompts `COPYEDIT_*`, Stage.COPYEDIT)

- New Stage `'copyedit'` in state.ts, between `validate` and `assemble`
  (Python: 9b, post-validation, never blocks the report).
- One SMALL `callJsonWithRepair` call, `call_type 'copyedit'`,
  fail-soft → `[]` on any LLM/parse failure (Python catches LLMError).
- New prompts `copyeditSystem` + `copyeditPrompt(title, manuscript)` —
  verbatim from Python `prompts.py` (persona + COPYEDIT_SYSTEM literal,
  COPYEDIT_USER). Machine-verify char parity vs `uv run python`.
- Sanitation (exact port): items must be dicts; `quote`/`suggestion`
  non-empty; `kind` ∈ {typo, grammar, phrasing, terminology} (lowercased);
  quote resolved via `resolveAnchor(doc, quote, quote)` — null → DROP
  (hallucination guard); cap 40 items; quote/suggestion truncated to 300;
  `section` = `sectionOfBlock(doc, blockId)`.
- Divergence (documented, module docblock + CHANGELOG): Python gates the
  stage on `plan_knobs().copyedit` and `budget_allows('copyedit')` —
  both live in the budget harness (catch-up 7c). Pre-7c the stage is
  always-on; the knob checks are added in 7c.
- Persist `copyedit_items` stage artifact BEFORE the 'done' emit
  (artifact contract — resume must find it);
  `stageHasArtifact('copyedit')` requires it. Old runs: Partial stages
  keep loading.
- `RunState` gains nothing new beyond the artifact (Python keeps
  `copyedit_items` on the report; keep parity: the artifact IS the list).

### 2. reference resolution (`literature/reference_resolution.py` →

`src/literature/reference_resolution.ts`)

- `splitReferences(referencesText)`: exact port (start_re
  `^(\[\d+\]|\d{1,3}[.)]\s|[-•]\s|\*\s?)`, blank-line flush, >15 chars
  filter, whitespace collapse).
- `titleGuess(entry)`, `queryFor(entry)` ([:220]), `_norm` — exact ports.
- `similarityRatio(a, b)`: faithful port of Python
  `difflib.SequenceMatcher(None, a, b).ratio()` (find_longest_match b2j
  recursion + ratio = 2M/(la+lb)) as `src/util/sequence_matcher.ts` —
  NOT a lookalike; scores feed a 0.72 threshold so drift changes
  match outcomes. Parity-harness against `uv run python` (repr of scores
  over ≥20 entry/candidate pairs incl. unicode + punctuation).
- `resolveReferences(referencesText, clients, opts)`: per entry —
  Crossref `lookup(query)` + OpenAlex `searchWorks(query, 3)`, both
  fail-soft per-call; best score = max(ratio, whole*0.9) where
  whole = ratio(norm(entry)[:220], norm(itemTitle));
  matched iff score ≥ 0.72. MAX_REFS 60, CONCURRENCY 4 (mapPool),
  OVERALL_TIMEOUT_S 60 → timeout = all-unmatched-with-error records.
  Record shape: `{ref[:240], status, score[:2], doi?, title?, venue?,
year?, source?, error?}`.
- Deterministic, zero LLM cost. Fetch is live network (Crossref/OpenAlex
  CORS verified) — unit tests inject stub clients, e2e pins the
  no-network thrower (the module takes the clients as args, so tests
  never hit fetch).

### 3. Wire into the bibliography stage (Python `_resolve_references`)

- New `runReferenceResolution(init)` exported from the orchestrator side
  or bibliography.ts: memoized on RunState (`doi_resolutions` artifact —
  persist it; `stageHasArtifact` untouched: it feeds bibliography, does
  not gate it).
- Renders the resolution block via `renderResolutions(records)`
  (exact port: `- MATCHED doi :: title (venue, year) [score s]` /
  `- UNMATCHED :: ref [best score s]`, [:20000], `'(resolution
unavailable)'` when empty) into the NEW `bibliographyPrompt` slot —
  Python `BIBLIOGRAPHY_USER` grew a `{resolution}` section (with the
  MATCHED/UNMATCHED explanation paragraph) between intext and context.
  Update the TS template + call sites; re-run the char-parity harness
  for `bibliographyPrompt` against Python `.format()`.
- `bibliographySystem` is STILL char-identical upstream (verified
  2026-10-18) — do not touch it.
- Unmatched records (first 20) become deterministic checker findings:
  `{check: 'doi-resolution', title: 'Reference not resolvable in
Crossref/OpenAlex', message: <exact port>, quote: ref[:240],
category: 'reference', severity: 0.4, meta: {kind: 'unmatched',
score}, provenance: 'deterministic'}` — stored on RunState as
  `checkerFindings` (new field, additive). This is the minimal
  CheckFinding shape; 7b extends it with the full checkers.

### 4. Report surface

- `ReviewReport` gains `copyeditItems?: CopyeditItem[]`
  (`{quote, suggestion, kind, section?}`) — additive, optional, old
  reports load unchanged.
- `reportToMarkdown`: after validator notes (Python order: findings →
  validator notes → copyedit table → usage), render the
  `## Suggested language fixes (N)` section EXACTLY as Python
  (`render.py`): pipe table `| # | Kind | Location | Original |
Suggested fix |`, `|`+newline escaped, with the italic preamble
  verbatim.
- Comments carry optional `provenance?: string` now (field exists in
  upstream models; the deterministic findings and 7f badges need it).
  Populate it for doi-resolution findings. Do NOT change the Findings
  section split yet (7f).

## Out of scope (later catch-up stages)

- Full deterministic checkers (xref/number/table) + provenance badges +
  Findings/Deterministic report split → 7b/7f.
- Budget knobs for copyedit + `budget_allows` gate → 7c.
- Prompt A/B winners drift for meta/validator/survey (verified drifted
  upstream) → 7d.
- Pipeline e2e queues must ADD the copyedit SMALL response after
  validate (and the resolution is client-stubbed in pipeline tests —
  no live fetch).

## Tests (mirroring the conventions)

- `sequence_matcher.test.ts`: parity vs `uv run python`
  difflib reprs (fuzz ≥200 pairs) + edge cases (empty, unicode).
- `reference_resolution.test.ts`: splitReferences fixtures (numbered/
  bulleted/blank-line/multiline), titleGuess, threshold boundary,
  per-client failure fail-soft, timeout path, MAX_REFS cap.
- `copyedit.test.ts` (prompts parity + sanitation: dropped kinds, cap
  40, anchor-drop guard, 300-truncs).
- pipeline e2e: copyedit artifact persists; resume after validate does
  NOT re-call copyedit (artifact contract); resolution stubbed; report
  renders the fixes table.
- Old-run compat: runs without the new stages load.

## DoD

lint + typecheck + test + build green; prompt parity harness green
(copyedit new, bibliographySystem re-verified); docs (README status,
CHANGELOG, module docblocks incl. the always-on divergence); conventional
commits per module; PR stacked per bulk-merge convention (branch off
origin/main + Stage-6 content merge).
