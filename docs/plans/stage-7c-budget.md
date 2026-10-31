# Stage 7c — budget core (cost model, planner, per-phase spend)

Catch-up stage: port `pipeline/budget.py` (~1,460 lines, origin/main
`26ae883`) — the cost model + deterministic planner + per-phase spend
ledger + budget-driven mode + incomplete-run wrap-up with resumable
top-up. Branch `stage/7c-budget` off `stage/7b-checkers` (content-merge
carries 7a+7b; PR stacks for the bulk merge).

Owner decision (2026-10-18, verbatim): "Keep the presets as they are" —
the Python preset USD figures port unchanged.

## Scope

### 1. `src/pipeline/budget.ts` — full port of budget.py

Read the ENTIRE module first (`git -C ~/coding/open-referee show
origin/main:src/open_referee/pipeline/budget.py`) and port completely:

- Cost model: per-model pricing tables, `call_max_tokens(call_type,
out_level)` output-budget levels, input-token estimation from prompt
  sizes, `estimated_cost` computation.
- Deterministic planner: plan_knobs() (per-section lenses, whole-paper
  passes, defense round, copyedit, output_budget levels, depth presets)
  derived from the budget tier — NOT from LLM output. Python derives the
  plan from the preset + doc size deterministically; port exactly.
- Per-phase spend ledger (the pool `ledger` Python already threads
  through UsageSummary — check what the TS ChatPool already tracks and
  extend, don't duplicate).
- Budget-driven mode: when projected spend exceeds the tier budget,
  degrade knobs (fewer lenses/passes) rather than abort; hard abort at
  the hard cap with the BudgetExceeded error TS stages already
  propagate.
- Incomplete-run wrap-up: on budget exhaustion mid-run, the wrap-up
  report path (partial report with honest usage accounting) + the
  resumable top-up semantics (user raises the cap, run resumes from the
  failure point — the TS already has resume-from-artifacts; wire the
  budget state the same way: persist spent/projected on RunState).
- SETTINGS: the budget tier block joins settings (mergeSettings MUST
  round-trip it — the universal rule) and the UI settings fieldset
  gains the tier selector (keep presets as-is: the Python USD figures).

### 2. Gate wiring (closes the two documented 7a/7b divergences)

- `plan_knobs().copyedit` + `budget_allows('copyedit')` gates on the
  copyedit stage (7a docblocked this as always-on).
- `call_max_tokens('meta', out_level)` scaling for the meta call
  (Python: `max(call_max_tokens, min(32_768, 2_000 + 130*n_comments))`
  — port the formula; the max_tokens plumbing on TS ChatCall needs
  checking: does ChatCall support max output tokens? If not, add it
  provider-neutrally).
- Depth presets now come from the tier by default (user overrides
  still win) — `depthPreset()` from claims.ts stays as the fallback.

### 3. UI

- Budget tier selector in settings (preset figures verbatim), projected
  cost estimate display, spend-so-far in the progress panel.
- BudgetExceeded → the existing error/partial UI path with a clear
  "top up" affordance that resumes the run (already supported by the
  resume machinery — the button just resumes).

### 4. Tests

- budget.test.ts: cost model parity (pin Python computations via
  uv-run harness), planner determinism (same doc+tier → same knobs),
  knob-degradation ladder, ledger accounting, wrap-up + top-up resume
  e2e (interrupt on BudgetExceeded, resume with raised cap completes).
- mergeSettings round-trip test for the new block (universal rule).
- copyedit gate: with a tier whose knobs exclude copyedit, the stage is
  skipped (and un-skipped when included).
- Python-parity harness for plan_knobs on shared fixture docs/tiers.

## Out of scope

- committee/decisions (7e), fit/history (7g), recompute (7h).

## DoD

lint + typecheck + test + build green; cost-model + planner parity
harness green; the 7a/7b divergence docblocks updated to "closed in
7c"; docs (README, CHANGELOG); conventional commits; PR stacked.
