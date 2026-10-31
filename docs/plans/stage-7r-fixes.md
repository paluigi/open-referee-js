# Stage 7R — review-fix pass (7d/7e/7f findings)

Workdir ~/coding/open-referee-js. Branch stage/7f-yield (continues; do NOT
create a new branch). NEVER push. NEVER rebase/pull. Never `git add -A`.
Gates before any commit: pnpm format && pnpm lint && pnpm typecheck &&
pnpm test (578/53 green at handoff). Conventional commits, explicit paths.
Upstream ground truth: git -C ~/coding/open-referee show origin/main:<path>
(origin/main = 26ae883). Python probes: /tmp/or-py (uv run).

OWNER DECISION ALREADY MADE (do not re-litigate): parity target is
origin/main 26ae883. e2ba304 reverted 449174c's checker merge after a
real-world RMI failure (28 deterministic findings dissolved into one prose
comment). Fix F1 reverts to origin/main semantics, not 449174c.

## FIX GROUP A — e2ba304 realignment (7f F1) [fix(pipeline)]

Origin/main semantics:

- _meta: merged = list(validated) ONLY — checker findings do NOT enter
  the merge (their comment: "meta's dedup dissolved them").
- _validate: LLM comments only (dm gate + validator unchanged).
- _assemble: finalComments = list(checker_comments()) + final.comments —
  checker ALWAYS prepended fresh at assemble, provenance intact, no
  dedupe needed (they never entered the LLM stream).
- reattach_provenance against verify-stage candidates ONLY (checker carry
  provenance already; upstream test pins all det comments keep quote+provenance).

Edits in src/pipeline/orchestrator.ts:

1. Meta block (~line 2327): const merged = [...challengeValidated];
   update the 7f comment to the e2ba304 rationale + RMI numbers.
2. validate (~2418-2422): mergedValidate = [...challengeValidated];
   update comments. NOTE: with the merge gone, checker no longer force
   validate to run — validate runs only when challengeValidated.length>0,
   matching origin/main (its validate runs on draft.comments regardless?
   NO: check origin/main run loop — _validate runs unconditionally on the
   draft; the draft.comments after a no-challenge run is empty and validate
   still calls the LLM with 0 comments? Read origin/main stage list: if
   validated empty and no checker in draft, upstream STILL calls validate?
   CHECK test_yield + orchestrator: upstream runs _validate whenever the
   stage is reached (no length gate). TS has a length>0 gate from 7b.
   Keep the length>0 gate ONLY if origin/main has an equivalent guard —
   VERIFY via `git show origin/main:...orchestrator.py` around
   Stage.VALIDATE. If upstream validates unconditionally, keep the TS gate
   as a documented deviation ONLY if a test depends on it; otherwise drop
   the gate to match (validator with empty comments list is upstream
   behavior). Then decide the 'skipped' emit wording accordingly.
3. assemble (~2565-2575): finalComments = [...checkerComments(state),
   ...validated]; remove checkerSet + identity filter + its comment
   block. reattachProvenance: drop the `...checkerComments(state)` second
   arg — candidates only.
4. Remove the now-dead shared-instance comment at the `checker` binding
   (checker is still needed at assemble).

Tests:

- tests/pipeline_e2e.test.ts: flip the 7f pins — meta prompt must NOT
  contain any checker finding title; validate prompt must NOT contain
  checker titles; report still contains each checker title EXACTLY ONCE
  (assemble prepend) with provenance 'deterministic'. Add a port of
  origin/main test_yield.py::test_meta_does_not_dissolve_checker_comments
  and ::test_assemble_appends_checker_comments_with_provenance shapes.
- pipeline_resume_e2e / pipeline_budget_e2e fixtures: validate no longer
  receives checker comments — re-derive each queue from the ACTUAL new
  sequence (probe with a tsx harness before editing queues; do not guess).
  Where validate previously ran ONLY because of checker findings it may
  now skip — follow whatever you verified upstream does, and keep
  assertions on real counts.

## FIX GROUP B — 7e review majors [fix(pipeline)]

B1. orchestrator.ts claim inventory settle: set
harness.stats = { ...harness.stats, n_claims: inv.claims.length }
before rankClaims/committee (Python sets it as dominant-cost milestone).
B2. claims.ts verifyClaims: honor committee ranking — port the
_claims_ranked gate (Python verify_claims skips its importance sort
when the committee already ranked). Add the flag where rankClaims
result is stored; verifyClaims sorts only if not ranked.
B3. orchestrator.ts challenge replan checkpoint (~2216): remove
`&& decide !== undefined` so it matches the verify checkpoint gating
(isAuto && plan) and Python (replan runs regardless of decider).
B4. Reconcile unmet CHANGELOG claims: either (preferred, small) wire
wrapupIncomplete: on replanChoice false in auto mode, call
committee.ts wrapupIncomplete to produce the partial-report synthesis + record shortfall on state (add `shortfallUsd?: number` to RunState
in src/pipeline/state.ts, persisted), OR reword CHANGELOG. Prefer
wiring — it's ~10 lines and Python has it.
B5. verify sub-stage checkpoints: add replan checkpoints after the verify
sub-stages (claims/lenses/artifacts) mirroring the existing two
whole-stage checkpoints, OR reword the CHANGELOG bullet. Prefer adding
them (cheap: same helper) — but ONLY if the checkpoint helper is
callable mid-stage without breaking resume; if it complicates the
stage trail, reword CHANGELOG and note it.
B6. Wire decision-provider construction: in app.ts where providers are
built, when settings.decisionRole is bound, construct the decision
provider via createDecisionProvider and pass it as `decider` to
runReview (all 3 call sites — or thread through one builder). Also fix
orchestrator.ts:834 `settings.decisionRole!` → defensive read (missing
block = treat as no pricing, return undefined decider funnel result is
NOT wanted — Python propagates; just avoid the crash: if the block is
missing use zero pricing).
B7. committee.ts strategyCommittee: `res.kind === 'budget'` → rethrow
(propagate like Python BudgetExceeded) instead of falling into catch.

## FIX GROUP C — 7d review items [fix(providers) + fix(pipeline)]

C1. Make supportsReasoning reachable: add optional `supportsReasoning?: boolean`
to RoleConfig in src/config/schema.ts (universal rule: non-boolean
dropped; round-trip test in config.test.ts), thread through
createProvider/factory into the provider construction (chat providers
accept a flag or the factory wraps). Default false = today's behavior.
Update CHANGELOG 'reasoning models' bullet to reflect the config surface.
C2. orchestrator.ts twoPhaseReasoning LLMError paths (~1419,1444): return
undefined (fall through to the single repair replay) to match Python
(its try/except LLMError logs + falls to repair). Update the two_phase
test that pins the early-out if any does.
C3. CHANGELOG: one line noting Python config llm.json_two_phase
'always'/'never' modes are unported (auto behavior only).
C4. tests/two_phase.test.ts: add the ledger callType assertion the review
flagged (4 triage-tagged records).

## FIX GROUP D — 7f minors [fix(pipeline)]

D1. Triage settle block: harness.stats.n_lenses = lensesFor(triage).length
(7f made the count vary 3-6).
D2. budget.ts lean-finish residual: DROP `synthesis: false` (Python
lean-finish does not touch synthesis) — BUT check the starved-resume
rationale: if dropping it breaks the lean-finish parity pin, keep and
document instead. Decide by reading origin/main budget.py
residual_frontier.
D3. orchestrator.ts runSynthesis: 'budget' result must PROPAGATE (set
budgetError / rethrow) like other stages, not degrade — Python
BudgetExceeded drains. Adjust the meta block so the drain semantics
match (synthesis budget-trip → budgetError → skip validate, partial).
D4. tests/pipeline_budget_e2e.test.ts comment fix (~449): synthesis AND
copyedit affordance gates are closed at this pricing — fix comment.

Run full gates, then commit in this order (explicit paths):

1. fix(pipeline): checker findings assemble-only per e2ba304 (Group A)
2. fix(pipeline): 7e review — n_claims, ranked-order gate, checkpoint
   gating, wrap-up shortfall, decider wiring (Group B)
3. fix(providers,config): reasoning capability config + repair-replay
   fallthrough (Group C)
4. fix(pipeline): review minors — n_lenses, lean-finish, synthesis budget
   propagate (Group D)
5. docs: CHANGELOG/README for the fix pass

Report: per group — what changed, files, test counts after each commit,
any deviation with one-line justification.
