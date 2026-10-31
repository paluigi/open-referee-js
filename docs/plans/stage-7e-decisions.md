# Stage 7e — decision models, committee planning, batched dm_defense

Catch-up stage: the decision-model layer + committee planner + batched
defense adjudication (upstream b04cf21, eaa1a85, 4132423). Branch
`stage/7e-decisions` off `stage/7d-two-phase` (content-merge carries
7a-7d; PR stacks for the bulk merge).

Upstream commits in scope: b04cf21 (decision models, committee planning,
frontier replanning, uncapped presets), eaa1a85 (fit works without a
decision role), 4132423 (batched decision-model adjudication). This is
the largest single delta (~2,768 insertions upstream) — split the wave
into two sub-waves if needed:

## Sub-wave A: decision provider + dm_defense batching

1. `DecisionProvider` port (`providers/decisions.py`, 183 lines):
   `/v1/decisions` predicate/choice/score questions, typed answers +
   distributions, usage booked in the ledger. TS: a `DecisionsClient`
   alongside ChatProvider (provider-type `decision`), with a
   `FakeDecisionProvider` for tests. RoleGain: `Role.DECISION` ('decision'
   role in settings, optional everywhere — eaa1a85).
2. dm_defense batching (4132423): `DM_BATCH_COMMENTS = 40` per decide()
   call; each listing entry carries the anchored manuscript passage next
   to the defense; per-batch failure upholds only that batch; budget
   learns `dm_defense` (ceil(comments/40) calls, doubled on
   defense_second_round). Wire into the TS defenseRound.

## Sub-wave B: committee planning + integration points

3. Committee planning (auto mode): ~10-point feasible-by-construction
   frontier over depth (claims by rank) × breadth axes; strong LLM
   reflects (no commit authority, never sums costs) → DM chooses → DM
   confirms; one more DM round on rejection commits unconditionally.
4. Replanning: checkpoints at stages + verify sub-stages + spike detector
   (≥8x) rebuild a residual frontier (4-5 continuations) from residual
   budget with ranked-claim context and observed yield; single-option
   repairs apply with no call; DM choice escalates to one LLM
   consultation under 0.5 confidence. Wrap-up mode (7c's harness
   briefing already ports the payload — now feed it).
5. Integration points (each behind the decision role being configured;
   labelled LLM fallback when absent): fit verdict, claim ranking,
   strategy choose/confirm, replan choices, triage classification (DM
   closed-set + LLM generative split), surveyor relevance filter,
   defense verdicts+severity, validator grounding gate.
6. UI: decision provider config + role binding (follow the existing
   provider fieldset pattern); settings decision block round-trips
   (universal rule).

## Tests

- Decisions client unit tests (typed answers, distributions, usage
  booking, malformed answers) + FakeDecisionProvider parity.
- dm_defense batching: batch boundaries, per-batch failure uphold, budget
  call counts (ceil + second-round doubling).
- Committee: frontier construction (feasible-by-construction property),
  reflect→choose→confirm ladder, rejection escalation, checkpoint
  rebuilds, single-option fast-path.
- Each integration point: with-DM and without-DM (labelled fallback)
  paths.
- Full e2e recompute: without a decision role configured, call sequences
  are UNCHANGED (DM layer dormant) — pin that.

## DoD

lint + typecheck + test + build green; docs (README, CHANGELOG);
conventional commits; PR stacked.
