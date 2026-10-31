# Stage 7f — yield upgrades: synthesis essay, checker findings merge, wider gates

Catch-up stage: upstream 449174c (checker findings join the report,
synthesis essay, wider gates) — the parts of the yield commit NOT
already delivered by 7b/7e. Branch `stage/7f-yield` off
`stage/7e-decisions` (content-merge carries 7a-7e; PR stacks for the
bulk merge).

Upstream commit in scope: 449174c. Also verify nothing was missed from
e2ba304/7bdbdc7 (7b) and 227d534 (partial — multi-pass verify /
reproduction voting / auditor role are NOT in 7f; they stay with the
later depth stage or get dropped with owner note if superseded).

## Scope

1. **Checker findings merge into `_meta`**: state.checkerFindings join
   the comment stream with provenance (deterministic/recompute)
   preserved; mechanical findings skip defense and land directly in the
   merger + validator. (7b added the report section; this adds the
   merge-into-meta plumbing Python does.)
2. **Synthesis pass**: new lead-referee essay (4-6 argued themes over
   deduplicated comments) replaces the merger's overall feedback;
   `synthesis` knob, False on the min-viable floor; priced +
   output-budgeted (callMaxTokens('synthesis', level)); e2e fixture for
   the new call.
3. **Wider gates**: comment window 60k→100k chars; `_est_comments` cap
   120→200; DM validator gate screens ALL comments in 60-question
   chunked predicate batches (7e's decide funnel; dormant without a
   decision role).
4. **New lenses**: stats (statistical rigor/reproducibility — added for
   empirical papers) and clarity (technical ambiguity — always on).
   Lens prompt parity + routing rules.
5. **Defense second round**: knobs.defense_second_round runs a second
   full adversarial round over survivors (deep plans); planning counts
   doubled when enabled (budget.py + PRESET_KNOBS figures verbatim).

## Out of scope

227d534 remainder (multi-pass verify, reproduction voting, auditor
role) — assess against 17ee582's depth-engine catalogue; likely fold
into a dedicated depth stage or propose dropping with an owner note.

## Tests

- Meta-merge: checker findings preserve provenance through the merger +
  validator; mechanical findings skip defense (e2e pin).
- Synthesis: knob off → old overall_feedback path (queues unchanged);
  knob on → new call with themed JSON; priced; floor knob off.
- Lens routing: empirical paper gains stats lens; clarity always.
- Defense second round: count doubling in the plan; e2e with the knob.
- Full gates; no-DM sequences unchanged; prompt char-parity for new
  lens/synthesis prompts (uv-run harness).

## DoD

lint + typecheck + test + build green; docs (README, CHANGELOG);
conventional commits; PR stacked.
