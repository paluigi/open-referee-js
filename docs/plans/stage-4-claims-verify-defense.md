# Stage 4 — Verification engine: claim inventory, typed verifiers, defense gate

Branch: `stage/4-claims-verify-defense` (off `main` after PR #4 merges —
rebase/verify merge-base first).
Python reference: `src/open_referee/pipeline/claims.py` (336 L),
`prompts_claims.py` (273 L), orchestrator `_verify`/`_challenge`/
`_lenses_for` (L425-600), `DepthPreset` (config L144-175).

## Scope

Port the verification mechanics on top of the Stage-1 pipeline skeleton:

1. **`src/pipeline/prompts_claims.ts`** — verbatim port of all prompts:
   CLAIM_INVENTORY_SYSTEM/USER, CLAIM_VERIFY_SYSTEM_TEMPLATE +
   `claimVerifySystem(claimType)` (%PLACEHOLDER% replace, NEVER .format —
   same convention as prompts.ts), TYPE_SPECIFIC ×9, CLAIM_VERIFY_USER,
   FIGURE/TABLE_VERIFY_SYSTEM, ARTIFACT_VERIFY_USER, DEFENSE_SYSTEM/USER,
   ADJUDICATION_SYSTEM/USER. Imports REFEREE_PERSONA/SEVERITY_RUBRIC/
   COMMENT_SCHEMA from prompts.ts. Char-parity checked the same way as
   Stage 1 (diff runtime values vs `uv run python`).
2. **`src/pipeline/claims.ts`** — port of claims.py:
   `runClaimInventory` (strong, triage JSON, sanitation: components
   required, id/type/importance defaults), `verifyClaims` (concurrency
   pool = 4 — Python uses max_parallel_calls default 8; TS pool fixed 4
   per plan, importance ordering central<supporting<peripheral,
   maxClaims cap, definitions pack per claim, per-claim progress events),
   `findMentions` + `verifyArtifacts` (vision role when configured;
   TS: vision IS optional — skip silently when no vision provider bound),
   `defenseRound` (small defense → strong adjudication, dismissed drops,
   adjusted merges, gate failure keeps the comment), `_definitionsFor` +
   `_lightGlobalPack`, `_passageFor` (findBlocks window).
3. **State machine** — extend `Stage` union: add `'claims'`, `'verify'`
   (replaces nothing; challenge stays), keep existing stages; update
   STAGES order: triage → claims → survey → verify → challenge → meta →
   validate → assemble. NOTE: Python order is ingest→triage→claims→
   survey→scout→verify→challenge→bibliography→meta→validate→assemble;
   TS keeps the Stage-1 narrowed flow + new stages (survey/scout/
   bibliography remain future stages 5/6). Old runs in IndexedDB with the
   6-stage shape must not crash (stages is Partial).
4. **Orchestrator wiring** — claims stage after triage; replace the
   Stage-1 challenge section loop with verify (claims + lenses +
   whole-paper) then challenge→defense gate on the way out (Python calls
   defense_round after validation inside _challenge flow — mirror that:
   validate → defenseRound → candidates). Lenses: `_lensesFor(triage)`
   with PROSE/MATH/EMPIRICAL/LIT verifier prompts (already in prompts.ts —
   verify; port missing ones). Depth preset: add `maxClaims`,
   `perSectionLenses`, `wholePaperPasses`, `defenseRound`, `maxArtifacts`
   - `standard` defaults to settings (schema v stays 1 — additive with
     defaults; migration-safe via `??`).
5. **Concurrency pool** — reusable `mapPool(items, limit, fn)` helper
   (tests: order preservation, error isolation, limit respected).
6. **Vision** — verifyArtifacts uses vision provider only when
   `settings.roles.vision.provider` is set AND builder produced it;
   RunReviewOptions gains optional `vision` provider. Images:
   ChatMessage.images (exists? check base.ts — Python has images=[...] on
   ChatMessage; TS may need the field — anthropic/gemini adapters send
   image blocks, openai content array; IF adapters lack image support,
   scope vision passes OUT of this stage and note it for Stage 5+).

## Constraints

- Prompts verbatim (char-identical); %PLACEHOLDER% replace convention.
- No new deps. Tests: fake providers (extend providers/fake), no network.
- Gates green before every commit; one conventional commit per module;
  subagents never push.

## Waves

- **Wave A:** prompts_claims.ts (+parity harness vs Python) — blocking
  for B (imports it). Small: could fold into B.
- **Wave B:** claims.ts + mapPool + state/orchestrator wiring + tests.
  Dispatch sequential (B imports A's exports). Reviewer parallel with B.
