# Open Referee (JS)

A fully static, client-side TypeScript port of
[open-referee](https://github.com/paluigi/open-referee): an AI referee that
reviews academic papers with literature grounding. **Everything runs in your
browser** — document parsing, the review pipeline, the report. The only
network traffic is the calls to the LLM endpoints _you_ configure (plus
CORS-open literature APIs: OpenAlex, Crossref, Tavily, TinyFish).

- Installable as a **PWA** (planned Stage 7): network-first with local
  fallback; website updates invalidate the local cache.
- Your API key never leaves the page and is never persisted — it lives in
  memory for the session only (opt-in encrypted storage arrives in Stage 2).

## Status: Stages 1–6 + 7a–7f complete

This is a working vertical slice of the port. It is **not** yet at full
feature parity with the Python original. The pipeline is now:
triage → claims (atomic claim inventory) → survey (literature: OpenAlex +
web router + LLM surveyor + Crossref missing-reference lookup, deduped into
a context pack) → scout (PubPeer / OpenReview / PREreview community scans)
→ verify (per-claim typed workers + section lenses + whole-paper coherence)
→ challenge (per-section + whole-paper challenger + defense gate) →
bibliography (SMALL citation audit against the context pack, preceded by a
deterministic Crossref/OpenAlex reference-resolution pass whose MATCHED/
UNMATCHED ground truth feeds the audit prompt and RunState checker
findings) → meta-review → validate → copyedit (SMALL language-mechanics
annex; verbatim quotes anchor-verified, rendered as a "Suggested language
fixes" table) → assemble, with a budget cap that drains into a **partial
report** instead of discarding the run, a live progress bar, comment→block
anchor links in a scrollable manuscript pane, a clean print stylesheet, and
a resume list for in-progress runs (persisted per-stage artifacts).

Stage 7b adds the **deterministic checkers pass** (zero LLM cost) at the
verify head: cross-reference resolution (duplicate labels, dangling
figure/table/theorem/equation/section references, orphan classes,
non-monotone numbering), number consistency (the same named quantity
reported with different values in abstract vs body), and table arithmetic
(total-row and row-total recomputation with conservative tolerances).
Findings persist on RunState (resume skips the re-scan) and join the report
as `deterministic`-provenance comments in their own "Deterministic checks"
section — the Findings section now carries provenance tag lines
(`_[severity 0.85] · [statistical] · [claim_verify 2-of-2]_`).

Stage 7c adds the **budget core**: a hard spend cap (`maxCostUsd`) checked
before every model call, budget depth tiers (fast / standard / deep / auto)
that drive the review depth presets, a projected-cost estimate and
spend-so-far in the UI, and **resumable top-up** — a drained run wraps up
a partial report, and raising the cap and resuming completes the review
without re-calling completed stages. The copyedit annex now obeys its
plan knob and the budget gate, and the meta review's output budget scales
with the comment count.

Stage 7d ports the **two-phase JSON call ladder** for reasoning models
(phase-1 reasoning at a 24k budget, phase-2 JSON emission, low-effort
emission retry before the free-form fallback; inert for non-reasoning
providers), the seeded-error A/B prompt winners (inventory coverage,
figure-text pair contract, meta preservation contract, evidence-based
validator drop rules), provenance re-attachment after meta/validate
re-emission, a scaled meta input cap, and a robustness batch: bare-list
JSON envelopes tolerated, non-dict comment items skipped, `LLMError` on
JSON-repair failure, retry logging (model / attempt / error / backoff),
HTML-anchored headings + a heading-heuristic sectioning fallback,
polite-pool `mailto=` emails for OpenAlex/Crossref, ContextPack rebuilt
from its persisted artifact on resume, and challengers that respect the
budget gate (candidates pass through unvalidated instead of draining the
cap).

Stage 7e adds the **decision-model layer**: an optional `decision` role
speaking the `/v1/decisions` API (typed predicate/choice/score answers)
that a planning committee uses in auto mode — the strong LLM reflects on
a feasible depth×breadth frontier, the decision model chooses and
confirms a path, and mid-run checkpoints rebuild residual plans when
spend or spikes demand it. Without a decision role configured the layer
is fully dormant (labelled LLM fallbacks, unchanged call sequences).
Claim-defense verdicts are batched (40 comments per call, anchored
passages inline) so large comment sets stay checkable. Stage 7f raises
the yield: a lead-referee synthesis essay replaces the merger's overall
feedback, and statistical-rigor + clarity lenses widen per-section
coverage (deep plans re-run the defense gate over survivors). Stage 7R
aligns the checker-findings flow with upstream e2ba304 (assemble-only,
after the merger dissolved deterministic findings in a real run) and
lands the 7d/7e review fixes: wrap-up-with-shortfall on infeasible
plans, committee ranking honored end-to-end, per-role
`supportsReasoning` settings, and decision-provider wiring in the UI.

Literature grounding is **fail-soft**: a dead or CORS-blocked API degrades
to a console warning and an empty result — it never fails the review run.
Search engines (Tavily, TinyFish; no Brave — CORS-blocked) are tried in
`searchOrder` with failover; their keys are session-only in the settings UI.

Porting roadmap and owner decisions: `docs/exploration.md` (§7) and
`docs/plans/2026-10-16-implementation-plan.md`.

| Stage | Scope                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1 ✅  | Skeleton: md ingestion, openai-compatible providers, budget ledger, min-delay rate limiter, orchestrator, report render, UI + progress |
| 2 ✅  | Anthropic/Gemini/Ollama/vLLM adapters, secrets vault, full settings UI                                                                 |
| 3 ✅  | PDF (pdf.js) + DOCX (mammoth) ingestion                                                                                                |
| 4 ✅  | Claim decomposition, verification lenses, defense–adjudication gate                                                                    |
| 5 ✅  | Literature: OpenAlex, Crossref, Tavily + TinyFish router, scouting                                                                     |
| 6     | Report UX: anchoring, print-to-PDF, run history/resume                                                                                 |
| 7     | PWA: service worker, cache invalidation on deploy, offline                                                                             |
| 8     | Depth presets (fast/standard/deep), release                                                                                            |

## Development

Requires Node ≥ 20 and pnpm ≥ 9.

```bash
pnpm install
pnpm dev          # dev server
pnpm test         # vitest suite
pnpm lint         # eslint + prettier
pnpm typecheck    # tsc --noEmit
pnpm build        # production bundle in dist/
```

## Provider notes

- **OpenAI-compatible endpoints** (OpenAI, vLLM, any compatible gateway) work
  out of the box: set the base URL, model names, and your key.
- **API key storage**: by default a key you type lives in memory for the
  current session only — it is never written to `localStorage` and disappears
  on reload. Optionally, use "set passphrase + encrypt keys" to create a
  passphrase-encrypted vault (PBKDF2-SHA256 → AES-GCM 256, per-vault salt,
  fresh IV on every write): keys are then stored encrypted under
  `openreferee.vault.v1` and never in plaintext. The vault locks on page
  unload or via the "lock" button; a wrong passphrase cannot open it.
- **Anthropic**: the browser call sends
  `anthropic-dangerous-direct-browser-access: true` (the Stage-2 adapter
  sets this header on every request).
- **Ollama**: browsers enforce CORS, so Ollama must be started with
  `OLLAMA_ORIGINS=*` (or your site's origin) — this is a browser security
  rule, nothing the app can code around.
- **Search engines**: Tavily and TinyFish are browser-callable (CORS-verified).
  Brave Search blocks browser CORS and is excluded from the JS port.

## License

MIT — see [LICENSE](LICENSE).
