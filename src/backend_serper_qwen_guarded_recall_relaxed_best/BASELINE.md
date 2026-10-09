# Batched paint research backend

An isolated replacement for `backend_serper`. The original backend and root npm entry points are unchanged. The default workflow uses only OpenAI: a main researcher, modular page extractor and separate database code matcher. It uses the existing root `.env`, dependencies and read-only `lazzumix.db`; no new package is required.

## Run

From the repository root:

```bash
node backend_serper_optimized/ai.js
node backend_serper_optimized/ai.js '{"brand":"Fiat","model":"Uno","automobileType":"car","manufacturingYear":2010,"country":"Brazil","predominantColor":"not specified"}'
node backend_serper_optimized/test_api.js
```

The CLI defaults to the existing Hyundai example. The copied server retains `/api/hello` and the existing OAuth setup. To adopt this backend in another caller, change its import to `backend_serper_optimized/ai`. `npm start` still starts the original backend.

Required environment: `OPENAI_API_KEY` and `SERPER_API_KEY`. Research and code matching use GPT-6 Luna Fast. Dense page segments prefer GPT-6 Luna Fast; simpler pages and overflow use GPT-5.6 Luna Standard. Gemini credentials are not needed or used by `AgenticLoop`; legacy `PAGE_ANALYSIS_PROVIDER=auto` also uses OpenAI only. `PAGE_TEXT_READER_URL` optionally changes the Jina reader fallback. `RESEARCH_CONCURRENCY` still controls the copied demo server; the AI module's scheduler works independently of any HTTP server.

## Research flow

1. Four complementary searches run together: local palette, original paint catalog, international model palette, and painted replacement parts. For a recognized requested hue, the local and international searches include its descriptive family terms; the other searches still explore the broad palette. Some omit the year to find historical/application catalogs that cover entire model ranges. Portuguese naming research prefers a candidate in the requested family instead of an unrelated early extraction.
2. Up to 12 promising pages start fetching. Each page enters extraction as soon as its own text arrives. After four pages finish, the main researcher sees initial results and available evidence, then plans the remaining searches for missing palettes, international/adjacent-year evidence, independent sources and naming equivalences. One available follow-up slot is reserved for Portuguese naming, using an observed international name and source codes when available; this query also runs if planning fails. It uses the existing search budget. Other page jobs continue during planning.
3. The next search batch and page retrieval expand coverage toward 25 readable pages. Ranking favors the model, paint documents and different domains. Pagination and linked paint brochures are discovered from fetched HTML. Failed fetches can be replaced with other discovered sources. Numeric and short model identifiers also require the manufacturer's name in search metadata unless the main researcher explicitly prioritizes the URL. While normal pages are processed, up to four additional searches investigate short paint names, with up to two pages per search. Same-code database descriptions can refine these search queries, but cannot become researched names without fetched evidence. Clarification pages contribute only names related to the investigated fragment or its source codes, not unrelated palettes.
4. The extractor reads numbered source units in approximately 12,000-character segments, overlapping about 800 characters at whole-unit boundaries. Every nonblank source unit is available; target sections deep inside catalogs run first. Long link destinations are hidden in the model display, and their original text remains available for evidence restoration. The model returns names and evidence IDs; the application restores and validates verbatim passages before main-agent review. Dense paint tables receive a second full-text pass that returns missed names and additional evidence. Ordinary navigation text no longer triggers duplicate reads solely because it mentions “paint” repeatedly. Primary candidates stream immediately, and successful passes survive audit failures. Identical page text for the same vehicle is analyzed once per run while retaining each source URL. Fully failed segments can still be recovered by the main agent.
5. A candidate inventory preserves names and verbatim citations across all successful extractions. It separates comma/slash alternatives and removes explicitly labeled or repeated catalog code prefixes. It preserves word order and language: apparent translations can identify different paints with different codes. A complete required-key schema forces a decision for every candidate: include with grounded page IDs, exclude with a reason, or merge a documented alias. The main agent reviews batches of at most 6 candidates, up to 16 concurrently. `review_input.js` sends repeated verbatim passages once per batch with references from every associated candidate/source; no evidence is summarized or dropped. Single-word names need an explicit completeness decision; ambiguous fragments are retained in `research.unresolvedNames`, outside the final palette. Genuine complete one-word names remain valid. An unsupported name rewrite falls back to the original source name with a warning. The main agent decides model/generation/year/market/color-family applicability; the page agents supply extraction leads.
6. The final code agent receives the palette, original source passages and eligible database rows in concurrent batches of four colors. Python indexes words and codes once per lookup. Retrieval covers complete name words, hue translations, common abbreviations, close spelling variants and codes explicitly quoted in source evidence. These are retrieval leads: the agent must check complete identity, hue, make and versions. Manufacturer preference and exact-row deduplication reduce its prompt. Other catalog years remain available because a database year is not a complete vehicle applicability range. Source code/name evidence disambiguates conflicting rows. When several codes remain genuinely plausible, all are returned as comparison options. Only values from supplied database rows can become output codes. Successful batches survive failures elsewhere.

The result is a set of comparison candidates, never a promise of a physical match. Same-model alternatives with unresolved years, markets or trims remain low confidence. Unrelated palettes and clearly different requested hue families are excluded. Names come from retrieved text, not search snippets; the model may remove a separately printed identifier but cannot replace a name with an invented translation. Image alt text and Product/Vehicle JSON-LD metadata supplement ordinary HTML tables and PDF text. Image-only PDFs still require OCR outside this implementation.

White, silver/gray and black are separate comparison families. White requests retain supported white, off-white, pearl-white, cream-white and ivory-white variants; low confidence or a reflective finish cannot justify adding a silver paint. Silver and gray remain mutual neighbors. `hue_review.js` flags conflicting name words in accepted candidates and aliases for a focused evidence check by the main agent before code matching. Name words alone never directly exclude a paint. These checks share the existing review deadline and retry/accounting path; failures leave the affected names explicitly unreviewed instead of emitting unchecked conflicting colors. Main review still judges names without recognizable hue words from their evidence.

## Time and depth

### Azera hue validation (2026-10-01)

The captured Azera 2017/branco run incorrectly included Sleek Silver and Ion Silver with reasons explicitly calling them non-white adjacent neutrals. The revised review rules distinguish the neutral families, and the conditional hue check prevents accepted conflicting names or aliases from bypassing that decision. Replaying those two paints plus Ice White against their unchanged saved evidence rejected both silvers and accepted Ice White (1.59 seconds, $0.000920 estimated AI cost).

A fresh run after the review change excluded silver, but did not discover the Ice White source. Initial family-aware searches and the Portuguese-query adjustment address that discovery gap without adding searches or narrowing all queries. The final Brazilian Azera 2017/branco run returned **16 white-family entries**, including **Ice White / WW7**, and no silver/gray entries. It took **36.75 seconds** (32.79 processing, 3.96 capacity waiting) and cost **$0.064027 estimated AI usage**. One incomplete extraction left it explicitly partial. These are individual runs, not a guarantee of exhaustive recall or model precision.

All **106 regression tests pass**, covering white-family conflicts, preserved silver/gray neighbors, aliases, evidence-based exceptions, invalid review responses, failed checks, and hue-aware discovery. Saved artifacts: `tmp/azera-hue-tests.log`, `tmp/azera-hue-replay.json`, `tmp/azera-hue-discovery-live.json`; full run: `tmp/serper-optimized/4c007958-755a-4922-8c11-0eeb2c9299d0/`.

```js
const { AgenticLoop } = require('./backend_serper_optimized/ai');
const abortController = new AbortController();
const result = await new AgenticLoop({
  targetTimeMs: 40000,
  maxCapacityWaitMs: 120000, // Additional capacity waiting, bounded across the run.
  signal: abortController.signal, // Optional caller cancellation.
  maxSearches: 10,
  maxNameSearches: 4,
  maxPageFetches: 25,
  fetchConcurrency: 12,
  onProgress: (event) => console.error(event),
}).loop(vehicle);
```

Use one instance per request. The default 40-second processing target gives research approximately 24 seconds, reserves the remaining time for review/matching, and protects the final six seconds for code matching. Name clarification runs alongside normal retrieval and shares its deadline. Set `maxNameSearches: 0` to disable its extra browser allowance. Serper and model requests retry transient failures once, within their stage deadline. Permanent/billing failures are not retried. An authentication/billing failure stops queued extraction calls to that provider for the run; the main-model recovery path can still return a partial palette and its additional usage is recorded. Capacity waits pause stage processing deadlines. Every admitted model request still has its own wall-clock timeout, and the default total capacity-wait allowance is 120 seconds. Caller cancellation or exhaustion of that allowance returns an explicit error with usage and timing. The 40 seconds remains a processing target: CPU parsing and filesystem work can exceed it, and capacity waits add to total response time.

Depth remains explicit: ten normal queries and up to twenty-five normal readable pages, plus the conditional name-clarification allowance, full extracted evidence and independent source comparison. Twenty readable pages is a research target rather than an error gate. If a site blocks access, a catalog is too long to finish, a review batch fails, a name remains unresolved, or available results fall short, the response reports `research.status: "partial"` and warnings. Successfully reviewed colors survive other batch failures. Debug `research.unreviewedCandidates` (public `research.unreviewedNames`) names every collected candidate whose review did not complete. Increase `targetTimeMs` for difficult archives when deeper completion is more important than the response target. Even a completed bounded search cannot prove that every possible paint was found.

## Output and debugging

The API/CLI response is compacted **after all agents finish**, in `final_output.js`. The public contract is now `formatVersion: 3`:

The formatter uses `paint_duplicates.js` after code matching to merge coating labels and evidence-supported omissions of hue/finish descriptors. It requires one identical unambiguous matched code and the same distinctive name/version words. For example, `Pure Pearl Tricoat` and `Pure Pearl White` can merge when the matcher-selected database description establishes that the shorter name denotes white pearl. Conflicting hues, finishes, manufacturers or versions prevent a merge; unknown descriptors remain separate. Code equality alone never merges different marketing names. Each group checks all original members to prevent an ambiguous name from bridging distinct shades.

The output prefers the fullest already-published name without a redundant coating label, preserves all source URLs and codes, and never invents a name. Full matched descriptions remain available until deduplication finishes and are then removed from public output. This adds no model calls. Replaying the latest saved Azera result (`0c90b21b-dfd9-4352-973e-961d1769e4f6`) reduced 15 entries to 14, retaining **Pure Pearl White / N2** and Ice White; saved ix35, Gol and CG 160 palettes stayed unchanged. All 15 formatter tests passed. Artifacts: `tmp/azera-identity-dedup.json`, `tmp/paint-identity-replay.json`.

```json
{
  "formatVersion": 3,
  "runId": "...",
  "vehicle": { "make": "Volkswagen", "model": "Gol", "year": 2015, "market": "Brazil" },
  "colors": [{ "name": "Prata Lunar", "codes": ["LR5S"], "confidence": "medium", "sources": ["https://example.com/catalog"] }],
  "usage": {
    "inputTokens": 100, "outputTokens": 20, "totalTokens": 120, "estimatedCostUsd": 0.00004,
    "byModel": [{ "provider": "openai", "model": "gpt-6-luna", "calls": 1,
      "inputTokens": 100, "cachedInputTokens": 0, "outputTokens": 20,
      "totalTokens": 120, "estimatedCostUsd": 0.00004 }]
  },
  "timeMs": 35000,
  "timing": { "totalMs": 35000, "processingMs": 32000, "capacityWaitMs": 3000, "modelRequestMs": 85000 },
  "research": { "status": "complete" }
}
```

Each color includes its source URLs directly in `sources`, deduplicated within that color. Version 3 replaces version 2's `sourceIds` and shared URL dictionary. `codes` contains every selected literal database value, including ambiguous alternatives, with no duplicate scalar field. Empty arrays mean no supported database code. Conditional `research.unresolvedNames` also includes direct source URLs; `unreviewedNames` lists every unreviewed name. Warning stage/count summaries and partial status remain visible.

`timing.totalMs` (also `timeMs`) is elapsed wall time. `processingMs` excludes the union of overlapping scheduler waits; a wait pauses the run clock even when another request is still running. `capacityWaitMs` counts those intervals once. `modelRequestMs` sums HTTP attempt durations across concurrent model calls, including retries, so it can exceed wall time. Search and page-fetch HTTP calls are excluded from that model sum.

`usage.byModel` groups reported usage by provider and model across all stages and service tiers, including call counts, input/output tokens, cached input tokens and estimated USD cost. Cached tokens are already included in input tokens. Costs sum the recorded tier-specific estimates; missing usage or prices yield `null`, and reported missing-usage calls appear as `missingUsage`. Older results without a cost ledger produce an empty breakdown. Error responses retain the breakdown as well.

For existing consumers, `new AgenticLoop({ outputFormat: 'expanded' })` retains the previous public fields (`universal_code`, `code_candidates`, per-color URL strings and detailed counters). Internally all agents still use full evidence and database rows. Debug `result.json` includes readable pages, fetch attempts/errors, per-agent token usage, model calls, cost details and stage timings. Research and its nested stages overlap, so summing stage durations is not total wall time.

Progress events contain a unique `runId`. By default each run writes requests, responses, fetched evidence and candidate decisions to `tmp/serper-optimized/<runId>/`. `result.json` keeps the full internal result; `response.json` records the compact public response. Original request snapshots are not overwritten; simultaneous runs have separate directories. Debug files contain search/page content and vehicle inputs, but no API headers or keys. Set `debugDirectory: false` to disable snapshots, or supply a directory for a particular run.

| File | Responsibility |
| --- | --- |
| `ai.js` | Research orchestration, deadlines, main-agent calls, partial results, diagnostics and CLI |
| `final_output.js` | Compact public response, applied only after agents finish and full diagnostics are saved |
| `page_analysis.js` / `page_evidence.js` | Provider calls, numbered source units, verbatim restoration and completeness audits |
| `model_scheduler.js` | Shared model admission, token/request budgets, priorities, provider feedback and cooldowns |
| `run_timing.js` | Capacity-wait accounting, pausable processing deadlines and cancellation |
| `ai_cost.js` | Dated, configurable token-price estimates, including cache discounts and uncached comparison |
| `portuguese_names.js` | Published Portuguese hue detection and targeted Brazilian naming query |
| `research_plan.js` | Seed queries, discovery index and source selection |
| `candidate_inventory.js` | Candidate consolidation, mandatory review schema and grounded output assembly |
| `review_input.js` | Lossless sharing of repeated review passages while preserving all source associations |
| `paint_evidence.js` / `name_research.js` | Printed-name identity, quoted code evidence and targeted full-name searches |
| `runtime.js` | Concurrency limits and bounded HTTP retries |
| `browse.js` | Serper localization and independently handled search results |
| `fetch_pages.js` | HTML/PDF retrieval, reader fallback, page text and catalog continuation links |
| `gemini_page_color_agent/` | Extraction prompts and the legacy Gemini compatibility entry point |
| `database_code_agent.js` / `.py` | Indexed local lookup and separate final code-matching agent |
| `prompts/research_plan.md` / `research_review.md` | Main-agent responsibilities and candidate inclusion rules |

The unused legacy loop prompts, alternate OpenAI page extractor, Brave adapter and serial server queue were removed from this copy. Their originals remain in `backend_serper`.

## Cost-aware extraction

The default `PAGE_ANALYSIS_PROVIDER=openai` uses GPT-6 Luna Fast for dense palettes and GPT-5.6 Luna Standard for short pages and overflow. Both receive the same numbered source units and use the same literal grounding validation and completeness audits. The main researcher and final code matcher remain separate GPT-6 Luna agents. No pages or candidates are discarded because the primary model's allowance is exhausted. There is no automatic Gemini fallback, even on OpenAI errors.

### Shared capacity scheduling

All OpenAI calls, including retries, enter the same process-wide scheduler: extraction, recovery, research planning/review and final code matching. Separate token/request buckets reserve estimated input plus output allowance before dispatch. Reported usage releases unused allowance; an attempt without usage retains its reservation. GPT-6 keeps 60,000 tokens available for main/final work rather than admitting more extraction against that reserve. Final matching has the highest queue priority, followed by main research, recovery and page extraction. Both models start with at most 20 simultaneous requests; rate-limit/service-unavailable responses reduce concurrency, and successful responses gradually restore it.

Provider limit/remaining/reset headers lower local ceilings and impose cooldowns. `Retry-After` is honored by shared admission before a bounded retry; billing failures are not retried. Queued jobs retain their input and do not lose their processing deadline while waiting. Progress emits `capacity_wait_start` and `capacity_wait_end`, including stage/kind and wait duration. Requests that exceed a model's configured capacity fail explicitly; they are not silently truncated.

The singleton shares capacity across `AgenticLoop` instances in **one Node process**. Default ceilings are configuration starting points, not a discovery of your account entitlement; set them to your account's limits (or lower allocations). Other processes/apps using the account are not coordinated, so allocate separate shares or supply a common external admission layer later. Sustained demand above the account capacity necessarily adds waiting or reaches the bounded queue/wait limits; a 30–40 second total response cannot be guaranteed under overload.

Configuration:

- `PAGE_ANALYSIS_PROVIDER`: `openai` (default) or `auto` (compatibility alias with the same OpenAI-only behavior). Explicit `gemini` remains available only for legacy comparisons/rollback; do not select it for the OpenAI-only workflow.
- `PAGE_ANALYSIS_SERVICE_TIER`: primary extraction tier, `fast` by default.
- Constructor `pageAnalysis` accepts `model`, `serviceTier`, `secondaryModel` and `secondaryServiceTier`. Defaults: `gpt-6-luna`/`fast` and `gpt-5.6-luna`/`default`. An explicit `model` disables secondary routing unless `secondaryModel` is also supplied; an empty secondary disables it. Old `PAGE_ANALYSIS_MODEL`/`PAGE_ANALYSIS_SECONDARY_MODEL` environment overrides are ignored; configure these through constructor options.
- `OPENAI_LUNA6_TPM` / `OPENAI_LUNA6_RPM`: primary ceilings, defaults 200000 tokens and 500 requests per minute.
- `OPENAI_LUNA6_RESERVED_TOKENS`: main/final reserve, default 60000 (must be below the TPM ceiling).
- `OPENAI_LUNA56_TPM` / `OPENAI_LUNA56_RPM`: secondary ceilings, defaults 500000 tokens and 500 requests per minute. Provider headers can lower these values; they never raise configured ceilings.
- Constructor `maxCapacityWaitMs`: maximum union of capacity waits per run, default 120000. `signal` supports caller cancellation.
- Constructor `scheduler`: optional shared `ModelScheduler` instance for custom per-model limits, concurrency, `maxQueue` (default 2000 waiting jobs) and per-job `maxWaitMs` (default 120000). Reuse this instance across runs. The default singleton is already shared. `PAGE_OPENAI_TOKENS_PER_MINUTE` and the old extraction-only budget no longer apply.
- Constructor `targetAiCostUsd` defaults to `$0.10`, leaving $0.05 of a $0.15 sale for hosting and margin. This is a reporting target, not a cap that truncates research. Exceeding it produces a cost warning.
- Constructor `tokenPrices` accepts overrides such as `{ 'openai:gpt-6-luna:fast': { input: 0.20, cached: 0.02, output: 1.00 } }`. Rates are USD per million tokens. Unknown models/tiers report a null estimate rather than zero.

Prices were verified on 2026-10-01 against [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and the [GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna). GPT-6 Luna standard is $0.10 input/$0.50 output per million tokens; Fast is $0.20/$1.00. GPT-5.6 Luna Standard is $0.20/$1.20. Historical Gemini estimates use $0.30/$2.50. `cost.entries` retains actual reported usage per provider/stage, including cached input and reasoning output; `uncachedCostUsd` shows the same usage without cache discounts. Estimates exclude SERP, hosting and unreported usage from failed requests, so they are not invoice totals or guaranteed per-request margins.

Fixed-source quality check: `evaluate_page_analysis.js` replays captured source pages without issuing new web searches. The final hybrid ix35 replay (`tmp/page-analysis-hybrid-ix35-v2.json`) retained **all 28 previously approved paint names**, took **23.31 s** for extraction, and cost **$0.06988** ($0.08227 without cache discounts). The captured Gemini extraction used 447,352 input and 33,863 output tokens, about **$0.21886** at current uncached rates. Two audit passes remained incomplete, with paired successful passes preserving the approved palette. This is a regression check on captured evidence, not proof of identical recall for every future query.

The earlier version 2 output reduced the saved ix35/Gol JSON sizes by **55–57%** using a shared URL dictionary. Version 3 restores direct URLs per color and adds per-model usage, so that size reduction no longer describes the current output. Formatting happens after the final agent and does not change model accuracy or API token charges.

The earlier cost/output revision passed **76 regression tests**, including restored literal citations, context boundaries, missing-name audits, provider routing, partial failures, cost arithmetic, complete code preservation and URL dictionary reconstruction. The version 3 formatter tests cover direct per-color URLs and per-model usage aggregation, including unknown costs and errors. Review requests now time out after 6 seconds and can retry once within the overall deadline; batches of six keep individual responses smaller. To replay a captured source set with live model calls:

```bash
node backend_serper_optimized/evaluate_page_analysis.js tmp/serper-optimized/RUN_ID/evidence.json tmp/extraction-comparison.json
```

The replay records missing prior extraction leads separately from missing previously approved names. It does not equate every old extraction lead with a correct vehicle paint.

Earlier OpenAI/Gemini Brazilian live measurements on 2026-10-01, excluding SERP:

| Query | Time | Total AI estimate | Same usage without cache discounts | Colors / readable pages |
| --- | ---: | ---: | ---: | ---: |
| Hyundai ix35, silver, unspecified year | 36.63 s | $0.08917 | $0.09252 | 29 / 30 |
| Volkswagen Gol 2015, silver | 32.25 s | $0.09503 | $0.10365 | 19 / 24 |

At a $0.15 selling price these measured AI costs leave approximately $0.055–$0.061 before hosting and other costs (about 37–41%). The uncached comparison leaves approximately $0.046–$0.057. These are individual measurements, not a cost ceiling: long documents, provider retries and quota contention can raise cost or return partial research. No search-depth cutoff was added to force the price result.

The ix35 run retained Shimmering Silver and code N3S, completed all review/matching batches, and reported one incomplete extraction pass plus unresolved short names. It precedes the final smaller-batch/review-retry adjustment. The final Gol run completed all stages without warnings. Intermediate tests exposed OpenAI quota contention and slow reviews; those runs were not treated as successful quality checks. Diagnostics: `tmp/serper-optimized/0a420709-850b-41bb-952a-369fecbfc9e7/` (ix35), `tmp/serper-optimized/3b1ce039-1d90-48d7-9c25-1c682b9d75d8/` (Gol).

### OpenAI-only validation (2026-10-01)

The final workflow passed **85 offline regression tests**, including primary-model quota reservations, OpenAI-only routing even with Gemini credentials present, no Gemini fallback on errors, per-model cost accounting, lossless review evidence references and explicit inclusion decisions. No search/page quota was reduced. Review prompts now clarify neighboring hue families and require inclusion objects to declare `action: "include"`, addressing inconsistent hue decisions seen during live testing.

Final Brazilian live measurements, using both OpenAI models:

| Query | Time | AI estimate | Same usage without cache discounts | Displayed colors / readable pages |
| --- | ---: | ---: | ---: | ---: |
| Hyundai ix35, silver, unspecified year | 36.21 s | $0.07157 | $0.09380 | 26 / 30 |
| Volkswagen Gol 2015, silver | 33.07 s | $0.05982 | $0.08515 | 19 / 25 |
| Honda CG 160 2022, red | 30.49 s | $0.05931 | $0.05931 | 3 / 18 |

All collected candidates were reviewed and all code-matching batches completed in these final runs. Shimmering Silver retained N3S; the Gol retained Cinza Platinum, Cinza Quartzo and its other documented comparison candidates. The motorcycle returned empty code arrays where the database provided no supported match. These live runs remain explicitly partial because some extraction passes timed out; the motorcycle also fell short of the readable-page target, and ix35 retained the ambiguous Hyper label as unresolved. Timing and cost vary with retrieval, model latency, caching and account load.

The fixed-source ix35 extraction replay retained **all 28 previously approved names**, finished every pass in **13.37 seconds**, and cost **$0.05839** ($0.06283 without cache discounts). The previous OpenAI/Gemini replay of that source set took 23.31 seconds and cost $0.06988. This comparison measures extraction-name retention on identical saved sources; full live palettes can differ as searches, available pages and review decisions change.

Diagnostics:

- ix35: `tmp/serper-optimized/66800908-5189-42f5-b509-983cfacd58d0/`
- Gol: `tmp/serper-optimized/b0e8ecfb-a293-4ad9-8d17-832001161e22/`
- CG 160: `tmp/serper-optimized/b08f6a92-6e83-49a5-a620-20210d6688c8/`
- Fixed-source replay: `tmp/page-analysis-openai-balanced-ix35.json`

## Name and code matching follow-up

### Brazilian names and output spelling

Gray/Grey spelling variants share their extracted evidence before review. Final formatting also consolidates these spellings, preserving every source URL and code alternative. Distinct version words remain separate. Codes with conflicting values remain comparison options rather than being replaced by an arbitrary scalar code.

Research actively seeks published Portuguese paint names while retaining international searches and source crossing. The main researcher prefers documented Portuguese aliases. After matching, the formatter can also prefer an already approved Portuguese candidate when the full-name vocabulary is equivalent and both names have the exact same single catalog code. Shared codes alone, ambiguous code choices, or different distinctive words do not justify merging. This intentionally leaves uncertain equivalents separate. Names without a verified local equivalent keep their published international wording; no marketing names are translated from memory.

Only after every agent finishes, color names receive Unicode title case (`CINZA TITÂNIO` → `Cinza Titânio`, `STEEL-GREY II` → `Steel-Grey Ii`). This includes unresolved/unreviewed name fields. Codes, URLs, model names, source passages and the detailed `result.json` are unchanged.

The earlier Portuguese-name revision passed **63 tests**. Replaying its saved ix35 and Gol runs below reduced 27 entries to 24 and 21 entries to 18 respectively, with all codes and source URLs preserved. A fresh Gol 2015 Brazil live check at that point was blocked by OpenAI HTTP 429 (no credits remaining); later cost-optimization checks above used replenished credits.

The follow-up regression suite contains **52 tests**. It covers preservation of published names (including cases where removing a finish would create a fragment), explicit short-name decisions, streaming extraction, independent clarification quota, database-guided search hints, source-code grounding, translations, spelling variants, distinct Titanium identities and partial matcher failures.

Live checks on 2026-10-01:

| Check | Time | Result |
| --- | ---: | --- |
| Matcher against captured Hyundai evidence and the actual database | 4.48 s | Shimmering Silver → N3S; Cinza Titanium → Y6G; Gray-Titanium → TAK |
| ix35, silver, Brazil | 36.20 s | 30 readable pages; 27 final names; 21 names with one or more code options; Shimmering Silver → N3S |
| Gol 2015, silver, Brazil | 35.58 s | 26 readable pages; 21 final names; 18 names with one or more code options |

The ix35 run used 10 normal searches plus four name searches. Hyper remained an unresolved lead because its source identities conflicted; it was not returned as a verified complete name. Both full runs reviewed every collected candidate and completed all matcher batches. Both were still marked partial for incomplete extraction and unresolved names; these measurements do not establish exhaustive recall. Earlier intermediate runs exposed review/matcher timeouts; the final budgets, streaming delivery and smaller matching batches address those failures, with partial-result reporting retained.

Full run directories: `tmp/serper-optimized/35ec9152-0a9b-49bc-ab7f-5bbf96529a30/` (ix35) and `tmp/serper-optimized/7a0fac2e-b537-488b-9e4e-703e60569f5c/` (Gol). The focused code check is saved in `tmp/database-matching-verification.json`. The final defensive name-normalization change was verified by regression tests after these live measurements.

## Validation

```bash
node --test backend_serper_optimized/*.test.js backend_serper_optimized/gemini_page_color_agent/*.test.js
```

If the environment prohibits test-worker subprocesses, add `--test-isolation=none`. The database regression tests require permission to launch Python and create a temporary SQLite fixture. Other tests use mocked providers and need no network credentials.

Regression cases cover multi-vehicle orchestration, candidate omission, named single-word paints, code/name separation, preserved extraction results after an audit failure, target sections late in long catalogs, partial review batches, failed search peers, retrieval fallbacks, schema grounding, whole-word database matching, make/year preferences and retries.

The initial optimization passed 38 regression tests. Its live tests on 2026-10-01 focused on Brazil-market cars, using the existing GPT-6 Luna and Gemini 3.5 Flash Lite configuration after Gemini billing recovered:

| Query | Wall time | Candidates | With database codes | Readable pages |
| --- | ---: | ---: | ---: | ---: |
| Hyundai ix35, silver, Brazil, year unspecified | 39.49 s | 22* | 11 | 25 |
| Volkswagen Gol, silver, Brazil | 32.87 s | 10 | 8 | 24 |
| Fiat Uno, 2010, full palette, Brazil | 29.41 s | 34 | 23 | 25 |

The original Hyundai baseline took **104.95 seconds**. The optimized Hyundai run included **Shimmering Silver**. Gol and Uno each cite eight domains across their final candidates. All three reported completed research with no unresolved review candidates. This describes completion of the bounded pipeline, not exhaustive historical coverage or confirmed fitment for every low-confidence candidate.

Run directories under `tmp/serper-optimized/`, in table order:

- `48474b9e-4c60-48cc-9f0f-9f5fcbafc0a9`
- `02291311-34a4-4ad4-9124-e3742fc600d9`
- `3c57c62d-af1d-45d6-ae6e-29559ee4609a`

*The measured Hyundai run predates the final repeated-code normalization fix. Replaying its captured pages confirms that `Rah Sleek Silver` now merges with `Sleek Silver` while Shimmering Silver remains. An earlier Uno run exposed an unsupported rewrite that rejected a review batch; replaying that response now preserves its 18 included candidates, and the final live Uno run completed successfully.

These are individual development measurements, not a statistical latency or recall guarantee. Earlier motorcycle/agricultural runs returned partial palettes when long documents exceeded the extraction budget. A Volvo FH white query produced no supported named candidates and returned an explicit error. Broad vehicle support still depends on accessible, named-paint evidence; the backend does not invent names when sources only say a generic hue. Provider failures also produce explicit partial results where usable evidence survives. Inspect each run's warnings and evidence; image-only catalogs, blocked pages and unusually long manuals remain coverage limits.


### Shared scheduler validation (2026-10-01)

The scheduler revision passed **89 offline regression tests**. They cover model reservations/routing, actual-model usage attribution, queue priority and overflow, lower provider limits, request/token reset headers, Retry-After longer than two seconds, concurrency adaptation, caller cancellation, bounded waiting, and the distinction between pausable processing deadlines and HTTP attempt timeouts.

Two live Brazilian vehicle requests ran consecutively in one Node process with the same scheduler:

| Query | Processing | Capacity wait | Total | AI estimate | Colors / pages | Reviewed / unreviewed candidates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hyundai ix35, silver, unspecified year | 32.32 s | 13.02 s | 45.35 s | $0.07906 | 29 / 29 | 137 / 0 |
| Volkswagen Gol 2015, silver | 31.09 s | 2.77 s | 33.86 s | $0.07270 | 14 / 25 | 70 / 0 |

No review or matcher batch failed. The ix35 retained Shimmering Silver with N3S; six pages had incomplete extraction passes and two short-name leads remained unresolved. The Gol retained Portuguese names including Cinza Platinum, Cinza Quartzo and Prata Sirius; one page had incomplete extraction. Both results therefore remain explicitly partial. These results show processing within the target and additional quota waiting; they do not promise 40-second total latency under contention. Uncached estimates were $0.07906 and $0.08516 respectively. Diagnostics: `tmp/serper-optimized/927fd35f-ef51-473c-883f-5648ec43fce0/` and `tmp/serper-optimized/c078a3a7-3b93-4ab9-b519-f2618306e17a/`.

The first fixed-source replay missed one formerly approved catalog name made from ordinary shade words, despite both passes completing. The extraction prompt now explicitly retains complete multiword names with their own catalog codes and requires audit reconciliation of labeled code/name rows. The final replay retained **all 28 previously approved names**, with zero incomplete passes, in **16.27 s** (13.74 s processing + 2.53 s capacity wait), costing **$0.06454 for extraction only**. Its 149 raw leads differ from the historical 162; preserving approved names on this captured source set is a regression check, not a claim of identical recall for arbitrary queries. Artifact: `tmp/page-analysis-shared-scheduler-ix35-v2.json`. The two full-run measurements above precede this final general prompt clarification.
