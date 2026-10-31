# Stage 7d — two-phase JSON, prompt A/B winners, robustness fixes

Catch-up stage: the remaining infra/robustness delta between the Stage-6
baseline (`b72f55e`) and origin/main (`26ae883`) that isn't checkers
(7b) or budget (7c). Branch `stage/7d-two-phase` off `stage/7c-budget`
(content-merge carries 7a-7c; PR stacks for the bulk merge).

Upstream commits in scope: 1515a7d, 8a8bb77, bfd2cdb, fe463f2, 61f5822,
c628796, 60d7779, 9a40f13 (validator part), 814c895, e5eedfa, 7949c40,
ed1d8da, 81f5a61.

## Scope

### 1. Two-phase JSON for reasoning models (1515a7d, 8a8bb77, bfd2cdb)

Python `complete_json` (orchestrator.py:130+): when the provider reports
reasoning support, phase 1 asks for the reasoning/plan at a raised
reasoning budget (24k), phase 2 emits the JSON with the reasoning in
context; a low-effort emission retry (bfd2cdb) fires before falling back
to the free-form single-shot path. Port the decision logic + phase
prompts + budget interplay exactly. Check the TS provider surface for a
reasoning-capability flag (Python: provider attribute) — add one
provider-neutrally if missing (default false for all current TS
providers; the path must be exercised via stubs in tests).

### 2. Prompt A/B winners (60d7779) + validator gates (9a40f13)

- Update TRIAGE/inventory prompts (seeded-error coverage winner),
  figure-text contract, META prompt (preservation contract — the drift
  the 7a/7b reviewers flagged). Char-parity harness re-run against
  origin/main prompts.py.
- VALIDATOR: replace the old DROP rule with the evidence-based gates
  (9a40f13) + `_reattach_provenance` port (orchestrator.py:1675,1821 —
  the guardrail the 7b reviewer flagged: re-attach provenance/claim_id
  from verify-stage candidates by anchor/quote matching after meta/validate
  re-emission).
- Scaled meta budgets: the 7c formula exists; verify the input cap too
  (Python max(100k, 900*n) vs the TS fixed 60k slice — 7c review P3;
  close it here).

### 3. Robustness fixes (each its own commit, each with a regression test)

- fe463f2: bare-list JSON envelopes (LLM returns `[...]` where `{...}`
  expected) — find Python's tolerance points and port.
- 61f5822: non-dict items in validated/comments lists are skipped.
- c628796: JSON-repair failure raises LLMError, not a raw parse error.
- 814c895: retry logging (model, attempt, error, backoff) — TS logger
  equivalent; keep it out of console.log (use the existing debug
  facility or a collectible hook).
- e5eedfa: sectioning — HTML-anchored headings + heading-heuristic
  fallback (ingestion; parity fixtures).
- 7949c40: OpenAlex/Crossref polite-pool email env fallbacks (TS:
  settings/env — document the browser story; the polite pool fields on
  the clients if absent).
- ed1d8da: rebuild ContextPack from its persisted artifact on resume
  (TS survey artifact restore path — check it round-trips all fields).
- 81f5a61: challengers respect the budget affordance gate (Python checks
  the harness gate before each challenger call — verify the TS challenge
  loop checks allow_call and degrades identically).

## Out of scope (7e+)

4132423 (batched decision-model adjudication), b04cf21/eaa1a85 (decision
models, committee, frontier replanning), 26a443d (run-history dataset),
227d534 remainder (multi-pass verify, reproduction voting, auditor
role), 449174c (synthesis essay), ee2ca81/17ee582 (recompute depth
catalogue), e0fb777 (eval harness — test-only, likely skip with owner
note).

## Tests

- Two-phase: stub provider with reasoning flag — phase sequencing, retry
  ladder, fallback; budget interaction (phase-1 reasoning budget
  booked?).
- Prompt char-parity re-run for all changed prompts (uv-run harness).
- Each robustness fix gets a pin from the Python behavior (uv-run where
  applicable).
- Full gates + e2e recompute (call sequences unchanged unless the
  two-phase path activates — it must NOT for non-reasoning stubs).

## DoD

lint + typecheck + test + build green; prompt parity green; docs
(README, CHANGELOG); conventional commits; PR stacked.
