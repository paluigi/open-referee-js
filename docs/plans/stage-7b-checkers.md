# Stage 7b — deterministic checkers (cross-refs, number consistency, table arithmetic)

Catch-up stage: port `pipeline/checkers.py` (703 lines, origin/main
`26ae883`) — the zero-LLM verification pass whose findings bypass the LLM
gates into the report. Branch `stage/7b-checkers` off
`stage/7a-copyedit-resolution` (content-merge carries 7a; PR stacks for
the bulk merge).

## Scope

### 1. `src/pipeline/checkers.ts` — full port of checkers.py

- `CheckFinding`: `{check, title, message, quote, section, category,
severity, meta}` + `toDict()` adding `provenance: 'deterministic'`
  (Python dataclass `to_dict`; `recompute` provenance reserved for 7h).
- `crossReferenceCheck(doc)`: exact port — `_CLASS_CANON` map,
  `_SKIP_CLASS_FOR_REFS = {'Definition'}`, `_MAX_XREF_FINDINGS = 8`;
  definitions from doc.theorems (label regex `^([A-Za-z]+)\s+(.+)`),
  figures/tables (caption regexes), first-3-lines of every block
  (`_LABEL_DEF_RE` + `_looks_like_definition` punctuation rule, prose
  length guard ≥120 for paragraphs, `_EQ_DEF_RE` for equations);
  section-number registry (parsed headings + `_ANY_NUMBERED_LINE_RE`);
  duplicate-label, non-monotone-numbering, dangling-reference (aggregated
  per class+label with `_window` 110/240 quotes + `_section_of`),
  missing-section (aggregated, worst-first 6), orphan-class findings.
- `numberConsistencyCheck(doc)`: exact port — `_NUM_RE` (with the
  `(?<![0-9A-Za-z.])` lookbehind — JS supports lookbehind), unit mention
  set, DOI/year/LaTeX-prefix/plain-integer exclusions, `_GENERIC_TAIL` +
  `_STRUCTURAL_TAIL` + `_CONNECTORS` word sets, `_split_abstract`
  (abstract blocks or ≤3 pre-heading paragraphs), `_mentions` prefix
  templates (`[\\d,.%]+ -> ' # '`), `_same_quantity` (last-two content
  words), `_consistent` tolerance (`0.6 * 10^-minDec` or 1% relative),
  abstract-vs-body + abstract-internal conflicts, dedupe by
  template+values, two-window quote. Severity 0.7.
- `tableArithmeticCheck(doc)`: exact port — `_parse_md_table` (separator
  rows, ≥3 rows), `_num` (paren-negative, comma/%, unicode minus),
  total-row column sums (tolerance `max(0.5*10^-dec, |total|*0.005,
1e-9)`, `:.6f`-strip decimals logic), total-named-column row sums
  (tolerance `max(|total|*0.005, 0.01)`, share/%/sum columns excluded),
  `_table_quote`. Sources: doc.tables markdown + `type === 'table'`
  blocks. Severity 0.7.
- `runDeterministicChecks(doc)`: the three in Python's order.
- All regexes must be cross-language behavior-probed (Python `re` vs JS)
  on shared fixtures — the established repr/JSON-pair harness.

### 2. Orchestrator wiring (Python `_verify` head + `_checker_comments`

- `_assemble`)

* In the verify stage, BEFORE the claim workers: if
  `state.checkerFindings` is empty, run `runDeterministicChecks(doc)`,
  store `[f.toDict() for f in findings]` on RunState (persist!), emit
  `verify running "deterministic checks: xref×N, ..."}` (sorted kinds
  string, exact Python format `", ".join(f"{k}×{v}" ...)`).
* The 7a `doi-resolution` findings stay in the same `checkerFindings`
  array (they already are); deterministic pass runs only `if
!state.checkerFindings.length` per Python — but Python checks
  `if not self.state.checker_findings` then appends; the doi findings
  are appended to the SAME list by `_resolve_references`. Match Python
  exactly: the checkers gate is `if not state.checkerFindings` (so a
  run that already has doi-resolutions findings skips the scan — and
  vice versa; Python has the same coupling).
* `_checker_comments` port (`checkerComments(state)`): findings →
  comment dicts (severity clamped `[0.1, 0.95]`, title [:160],
  message [:2500], paragraph_anchor = quote [:400], quote [:240],
  category, provenance default 'deterministic').
* `_assemble`: `finalComments = checkerComments + final.comments` —
  deterministic findings JOIN the report as comments (before validator
  output), provenance kept, anchored via resolveAnchor like the rest
  (`anchor_confidence` computed; section stamped). NOTE: this supersedes
  7a's "not report comments" — Python's final behavior is that they DO
  reach the report at assemble time (just not through meta/validate).
* Meta prompt: unchanged (deterministic findings do NOT enter meta's
  merge — Python comment explains the RMI dedup issue).
* Report render: comments with `provenance === 'deterministic'` (the
  `_DETERMINISTIC_PROVENANCE` set — check Python render.py for its
  exact members; it includes 'deterministic' and likely 'recompute')
  split into the `## Deterministic checks (N)` section with its verbatim
  italic preamble; LLM comments stay in `## Findings (N)` with the new
  provenance-tag preamble line (port both preambles exactly). The
  comment header itself changes: `_comment_header` renders
  `### {i}. {title} — _{section}_` + tag line `_[severity 0.35] ·
[reference] · [deterministic]_` (badges: severity 2dp, category
  default 'general', provenance when present; ' · '.join of
  bracketed badges). Port exactly; this replaces the current TS
  `[severity X.XX]Comment` header shape for ALL comments (parity
  harness against Python render_markdown on a fixture report).
* `ReviewComment.provenance` already exists (7a).

### 3. Document model prerequisites

- Verify the TS Document has `theorems` (label, statementBlockId),
  `figures` (caption, captionBlockId), `tables` (id, caption, markdown,
  captionBlockId), `blocks` (id, type, text, sectionPath). Python fills
  these in ingestion (extract_theorems/extract_tables); the TS side has
  the artifacts module from Stage 3 — extend if fields are missing,
  keeping old persisted docData loading (additive optional).

### 4. Budget-knob divergence (same as 7a)

Python gates nothing here (zero LLM cost) — no divergence.

### 5. Prompt drift guardrails (from the 7a review — NOT this stage's

scope, but the plan files must carry them so 7d doesn't miss them):
challenger/meta/validator prompt drift (9a40f13, 60d7779) stays queued
for 7d.

## Out of scope

- recompute (7h), provenance badge `claim_verify` values (7e), budget
  output-levels for meta (7c — meta max-tokens scaling stays as-is).

## Tests

- `checkers.test.ts`: per-check fixtures — document with duplicate
  Figure 1 labels, dangling "Figure 9" ref, orphan-class figure refs,
  non-monotone theorem numbering; abstract-vs-body number conflict,
  template matching, exclusion rules (years, DOIs, LaTeX, plain
  integers, generic tails); table total-row mismatch, row-total
  mismatch, separator/paren-negative/unicode-minus parsing, tolerance
  boundaries. Parity harness: run the TS checks on fixture documents
  AND the Python checks on the same docs (build the doc in Python via
  the ingestion module or hand-constructed pydantic models), pin JSON.
- Pipeline e2e: findings appear in the report as deterministic comments
  with provenance, in the `## Deterministic checks` section; resume:
  checkerFindings artifact contract (persist before verify-done emit;
  scan skipped when findings exist).
- The 7a e2e queues change again only if verify's emit detail assertions
  change (no new LLM calls — zero-cost stage).

## DoD

lint + typecheck + test + build green; regex cross-language probes
green; docs (README, CHANGELOG, docblocks); conventional commits; PR
stacked.
