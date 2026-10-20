# Stage 5 — Literature grounding + community scout (browser-CORS edition)

Branch: `stage/5-literature-scout` (off origin/main once PR #5 merges;
pull and verify merge-base first — Stage-4 HEAD da997a3 must be in base).
Python reference: `src/open_referee/literature/` (context.py 75L,
search.py 129L, openalex_client.py 161L, crossref.py 49L, scout.py 76L),
orchestrator `_literature` (L345-404) + `_scout` (L406-418),
`_hit_to_item` (L817), prompts.py SURVEY_SYSTEM (L74-80, ALREADY in TS
prompts.ts as surveySystem — char-parity re-verify), MAX_CITATION_SCANS=6.
Exploration: docs/exploration.md §3.4 + §C1 — OpenAlex/Crossref/Tavily/
TinyFish are browser-CORS-open; **Brave excluded (CORS-blocked, owner
decision)**; scout sources (PubPeer/OpenReview/PREreview) individually
optional — probe CORS at stage start, drop failures silently-with-notice
(owner decision: never fail the run).

## Scope

1. **`src/literature/types.ts`** — LiteratureItem (source/title/authors/
   year/doi/venue/citedBy/abstract/url/whyRelevant), ContextPack +
   `render(maxItems=25, maxAbstractChars=700)` — char-parity of render
   output vs Python (parity harness like Stage 4; field_hint/user_docs/
   bib_checks branches included), BibEntryCheck (bibliography is Stage 6 —
   port the type now, no logic).
2. **`src/literature/openalex.ts`** — raw REST only (no openalex-py
   equivalent): `GET api.openalex.org/works?search=&per-page=` with
   `api_key` param when set + optional `mailto` polite param;
   `searchWorks(query, limit=10)`, `getWorkByDoi(doi)`;
   abstract_inverted_index reconstruction (sort by position, join);
   map to LiteratureItem (display_name, authorships[:6], publication_year,
   doi-strip prefix, primary_location.source.display_name,
   cited_by_count, id as url). All fetches fail-soft: errors → [] / null
   - console.warn, never throw (Python logs and continues).
3. **`src/literature/crossref.ts`** — `GET api.crossref.org/works?
query.bibliographic=&rows=1`, polite pool via `User-Agent:
open-referee/0.1 (mailto:...)` — NOTE: browsers forbid setting UA;
   use `mailto` query param instead (Crossref supports it) and document
   the divergence. Map title[0], author given+family[:6], issued
   date-parts[0][0], DOI, container-title[0], URL.
4. **`src/literature/search.ts`** — SearchRouter over
   `settings.searchOrder` (FINALLY consumed; default ['tavily','tinyfish']):
   tavily `POST api.tavily.com/search {api_key, query, max_results}`,
   tinyfish `GET api.search.tinyfish.ai/search?query=&num_results=` +
   `X-API-Key` header (CORS-verified *). Hits: title/url/snippet(engine
   field names differ — tavily `content`, tinyfish `snippet`). Failover
   top-down until non-empty; `searchAll` for scout. Engine keys come from
   the vault (same resolveKey path as providers — check how Stage-2 vault
   stores search keys; if absent, add `searchApiKeys` to AppSettings
   session-only + optional vault). No Brave.
5. **`src/literature/scout.ts`** — PeerReviewScout: DEFAULT_SITES
   pubpeer.com/openreview.net/prereview.org + extraSites; scanTitle
   (`site:<domain> "<title clip 90>"`, limit 5, URL-domain filter) and
   scanCitation (limit 3) → LiteratureItem source='review_community'.
   Each engine call wrapped in a **CORS probe**: first call failure
   (TypeError from fetch = CORS/network) → mark site dropped for the run
   - one console.warn; never throws.
6. **Orchestrator wiring** — replace the Stage-1 placeholder survey block:
   - survey stage NOW: `_literature` port — queries from triage
     `search_queries`[:8] (triage prompt already asks for them),
     OpenAlex search per query until 30 items, web router queries[:3]
     limit 4 → source='web', dedupe by normalized title
     (`\W+`→'' lower [:80]), surveyor SMALL call on
     pack.render(maxItems=30) → why_relevant per selected index,
     missing_references[:5] → crossref lookup → append with
     why_important, field_hint += state_of_the_art_notes[:400].
     Best-effort: LLMError/BudgetExceeded propagate, other errors degrade.
   - NEW scout stage (add 'scout' to Stage union AFTER survey; STAGES
     order: triage → claims → survey → scout → verify → ...): scanTitle +
     key_citations[:6] scanCitation (strip `^.*?:\s*` prefix), extend
     pack items [:15]. Old-run compat: 6- and 8-stage runs still load.
   - Survey stage keeps its existing place; the old placeholder
     `artifacts.survey` skeleton is replaced by the ContextPack (store
     pack JSON in state artifacts for resume).
7. **Settings** — searchApiKeys (tavily/tinyfish) session-only in
   AppSettings + settings-UI fields (vault storage if the Stage-2 vault
   API makes it a small change; otherwise plain session-only like provider
   keys pre-vault) + searchOrder already exists. mergeSettings
   round-trips the new block (LESSON from Stage 4!) + round-trip test.
8. **Tests** — no network: stub `fetch` (globalThis) with scripted
   responses; CORS-failure = fetch rejecting with TypeError. Cover:
   openalex mapping + inverted-index reconstruction, crossref mapping,
   router failover (first engine empty → second; error → next), searchAll,
   scout domain filter + CORS-drop-after-first-failure, literature stage
   wiring (degraded-LLM vs degraded-network), dedupe, surveyor index
   mapping, render parity, scout stage events, mergeSettings round-trip,
   old-run compat. **Browser smoke check (Stage-3 LESSON):** after build,
   verify in real Chromium that the built bundle can actually fetch
   api.openalex.org (CORS preflight on the real thing, not stubs) —
   serve dist/, run one OpenAlex query from the page console; Crossref
   too. If a CORS block shows up in the real browser that stubs can't
   see, document + fail-soft is already in place.

## Constraints

- Prompts: surveySystem exists; re-verify char parity vs Python
  SURVEY_SYSTEM (it was ported in Stage 1).
- No new deps. One conventional commit per module; gates (prettier,
  eslint, tsc, pnpm test, build) before every commit; NEVER push.
- Fail-soft everywhere in the literature path: a dead API must never fail
  a review run.

## Waves

- **Wave A (sequential, single implementer):** types.ts → openalex.ts →
  crossref.ts → search.ts → scout.ts (each with tests) → orchestrator/
  state wiring → settings/UI → README/CHANGELOG. The modules are small
  and interlock; parallel waves would collide on types + orchestrator.
- **Reviewer** after Wave A completes: spec-vs-Python + quality +
  browser-CORS smoke verification.
