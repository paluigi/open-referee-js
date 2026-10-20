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

## Status: Stages 1–4 complete

This is a working vertical slice of the port. It is **not** yet at full
feature parity with the Python original. The pipeline is now:
triage → claims (atomic claim inventory) → survey → verify (per-claim typed
workers + section lenses + whole-paper coherence) → challenge (per-section +
whole-paper challenger) → meta-review → validate → defense–adjudication gate
→ assemble, with a budget cap that drains into a **partial report** instead
of discarding the run, and a live progress bar.

Porting roadmap and owner decisions: `docs/exploration.md` (§7) and
`docs/plans/2026-10-16-implementation-plan.md`.

| Stage | Scope                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1 ✅  | Skeleton: md ingestion, openai-compatible providers, budget ledger, min-delay rate limiter, orchestrator, report render, UI + progress |
| 2 ✅  | Anthropic/Gemini/Ollama/vLLM adapters, secrets vault, full settings UI                                                                 |
| 3 ✅  | PDF (pdf.js) + DOCX (mammoth) ingestion                                                                                                |
| 4 ✅  | Claim decomposition, verification lenses, defense–adjudication gate                                                                    |
| 5     | Literature: OpenAlex, Crossref, Tavily + TinyFish router, scouting                                                                     |
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
