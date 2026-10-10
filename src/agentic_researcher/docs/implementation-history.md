# Implementation history

This is the README preserved before the maintenance reorganization. It mixes
historical changes, benchmark results and earlier directory names. For current
commands and architecture, start with the [main README](../README.md).

---

# Paint research with optional paint-finish matching

An independent copy of `backend_serper_qwen_fallback_best`. The source backend is untouched.
OpenSERP searches Google, Bing and DuckDuckGo in parallel. The planning agent and final
code-matching agent keep their original four-model routing. Individual research
reviews, catalog identity checks and targeted extraction prefer Qwen.

## Mandatory catalogs and individual reviews

Every extracted named candidate is looked up in **both Lazzumix and BASF** during
research, including candidates with no catalog match. `catalog_lookup.py` indexes
the read-only catalogs once per run; initialization overlaps the initial search.
`catalog_research.js` schedules ambiguous identity checks with Qwen, up to six
concurrently. Repeated sightings of one complete name share a check. Exact complete
name + manufacturer + source-printed code matches can be established locally.

Each candidate then receives its own main research review, up to 16 concurrently.
Up to 12 early reviews (four concurrently) overlap ongoing page extraction.
Unchanged evidence reuses its early decision; changed evidence requires review
again. Temporary early decisions do not trigger paid code matching. Requested
hues and direct model/year evidence receive priority without discarding the
remaining uncertain candidates. Qwen capacity bursts can queue for up to 2.5 s
(`QWEN_CAPACITY_WAIT_MS`); actual API failures retain the existing fallback order.
Requested and uncertain hue candidates complete before unrelated hue reviews
can spend their fallback budget. Qwen candidate reviews have a five-second
attempt timeout, leaving time for fallbacks within the stage deadline. Semantic
decision and citation validation happens inside routing, so invalid decisions
can use a fallback rather than silently dropping the candidate.
An uncited finish claim is downgraded to unknown while preserving a valid paint
identity; matched catalog suffixes can establish finish later. Failed extraction
also salvages explicit `COLOR CODE … - …` and `Código da cor … - …` rows verbatim,
then submits those leads to the normal catalog and candidate reviews. It never
marks the unprocessed remainder of a page as complete.
The reviewer receives catalog identities, original year/range, normalized finish
evidence and verbatim web evidence. It can ask the extractor one targeted question
about a finish, code/name association, model/year heading or documented reuse of
another maker's paint. `targeted_extractor.js` returns literal passages from that
candidate's fetched pages; the reviewer makes a final decision with that reply.
If the follow-up fails or runs out of time, its provisional decision retains its
original evidence mapping. Initial seed queries and first-pass extraction are preserved.

Catalog dates corroborate availability; they never alone confirm a vehicle's
model year or prove a paint was unavailable in a neighboring year. Open-ended
ranges remain uncertain. Recognized suffixes supply finish evidence; missing
suffixes do not imply solid paint. Only confidently incompatible finishes are
excluded. Conflicting or unknown finishes remain eligible.

Cross-make matches require web evidence connecting the individual paint to the
vehicle or documented model range. Sharing a chassis or being a small manufacturer
does not authorize importing an entire donor palette. Proprietary and documented
donor paints can coexist. Sparse discovery adds broad brand paint-catalog searches
when the initial pass has no candidates, while retaining model applicability review.

The separate final matcher always queries both catalogs again using the final
name and accumulated source codes. It reuses an exact identity or an earlier
catalog-agent selection only when the fresh lookup still agrees on manufacturer
and a source-printed code. Other identities use the existing GPT matcher, in groups
of four. This avoids spending another request on an already established identity
while keeping ambiguous and cross-make choices with the matching agent.

The independent final verifier also reviews one color per call. It receives
selected catalog records alongside web excerpts; catalog evidence can support
identity/code/finish, never model-year applicability. Unsupported quotations leave
those facts unknown, with a warning, while valid checks from that review survive.
Catalog names appear in `verification.catalogs`; they are never fabricated web URLs.

### Unified BASF SQLite database

The root `basf.db` contains **107,111 rows from all 267 Feather files** in
`extracted_data/`. `paint_codes` stores description, manufacturer, universal/OEM
code, original year text, parsed year bounds and source-file/row provenance.
`import_files` records every input file, including empty exports.

The import allowlist is `Manufacturer`, `Color Name`, `Color Code`, and `Year`.
Here `Color Code` carries OEM values such as Hyundai N3S and Toyota 040.
Supplier fields `Std. No.`, `Std`, `Aux Code` and `Color Finder` are excluded from
SQLite and model inputs. Regional exports sometimes put supplier references such
as VW-2013 in `Color Code`; these are removed. A regional code is retained only
when its unprefixed value is independently present in that maker's native OEM
catalog. Names and years remain available when a safe code cannot be established.
Portuguese and English catalog names can be retrieved together through the same
manufacturer and OEM code; retrieval alone never establishes alias equivalence.

To rebuild from the repository root:

```bash
python3 -m venv /tmp/color-basf-import-venv
/tmp/color-basf-import-venv/bin/pip install -r backend_serper_qwen_finish/requirements-import.txt
/tmp/color-basf-import-venv/bin/python backend_serper_qwen_finish/import_basf.py
```

The importer checks integrity and replaces the destination atomically. Original
Feather files and `lazzumix.db` remain untouched. PyArrow is needed only for import;
the running worker uses Python's standard SQLite library. Both databases are
required: a missing database fails explicitly. `AgenticLoop` accepts
`databasePath` and `basfDatabasePath` overrides.

### Budget and tests

Default total deadline remains **40,000 ms**, including final verification.
Research searches normally stop around 12.6 s, fetches at 16 s, extraction at
19.4 s and recovery at 21.1 s. If discovery is starved, these four cutoffs can
borrow up to 3.6 s while preserving the overall deadline. Candidate review runs
until 29.1 s; overlapping final matching has until 32 s, leaving eight seconds plus
saved time for final verification. The final verifier queues at most 20 calls
concurrently, avoiding unnecessary fallback routes during a large palette burst.
Equivalent catalog editions are grouped without losing their descriptions,
original year strings or distinct finishes. Verification asks for concise,
non-repeating checks and gives Qwen 3.5 seconds per attempt before the existing
fallback chain, leaving room for recovery within the eight-second reserve.
The existing **$0.06 soft AI target**, reservations and per-model usage reporting
remain active. Provider latency can still produce partial results; unfinished
reviews and unsupported facts are reported rather than treated as confirmation.

Run deterministic regressions and the separate paid Brazilian evaluation:

```bash
node --test --test-concurrency=1 backend_serper_qwen_finish/*.test.js backend_serper_qwen_finish/gemini_page_color_agent/*.test.js
node backend_serper_qwen_finish/evaluate_vehicles.js all
node backend_serper_qwen_finish/evaluate_vehicles.js all --repeat=2
```

The live runner also accepts `ix35`, `azera`, `corolla`, `gol`, `puma`, `cruze`, or `s10` and saves
responses/events in unique suite directories under `tmp/catalog-vehicle-evaluation/`,
with one `summary.jsonl` per suite. Repeats run sequentially and report actual
OpenSERP HIT/MISS headers; the runner neither flushes the shared service cache
nor adds color hints to its queries. The restored Puma fixture
uses GTS 1978 / Vermelho Monte Carlo, with nearby-year evidence and no invented
donor code. Real-database tests cover Hyundai, Toyota and VW name/code bridges,
finish evidence and exclusion of supplier-only data. Historical benchmark notes
below describe earlier versions; this section describes the current architecture.

The Chevrolet cases use Brazil, Cruze 2018 and S10 2025, with both color and finish
omitted. They require `Prata Switchblade` and `Prata Shark`, respectively, among
the returned palette; other colors are allowed. Run both sequentially with
`node backend_serper_qwen_finish/evaluate_vehicles.js cruze s10`.

### Search reliability validation — 2026-10-03

**300 deterministic tests passed. All 14 final live runs passed** (two per vehicle),
with **193/193 final colors reviewed**. Runtime was **33.29–37.67 s** (median
35.74 s); AI cost was **$0.032940–$0.048130** (mean $0.039992), excluding SERP.
Runs fetched 21–39 pages including final verification. Model choices/fallback
order, the 40-second total deadline and the $0.06 soft AI target are preserved.

| Brazilian case | Required reference | Run times | AI costs |
| --- | --- | --- | --- |
| Hyundai ix35, silver | Shimmering Silver / N3S | 37.67 / 36.36 s | $0.038887 / $0.040429 |
| Hyundai Azera 2017, pearl white | Ice White | 34.06 / 34.37 s | $0.037546 / $0.045453 |
| Toyota Corolla 2018, pearl white | Branco Lunar / 070 | 35.04 / 36.76 s | $0.037835 / $0.034616 |
| Volkswagen Gol 2015, silver | Cinza Platinum / LD7X | 33.29 / 37.11 s | $0.036241 / $0.037524 |
| Puma GTS 1978, red | Vermelho Mont/Monte Carlo | 34.78 / 35.38 s | $0.032940 / $0.041914 |
| Chevrolet Cruze 2018, unspecified hue/finish | Prata Switchblade | 37.26 / 35.22 s | $0.041318 / $0.039321 |
| Chevrolet S10 2025, unspecified hue/finish | Prata Shark | 36.09 / 36.44 s | $0.047729 / $0.048130 |

The report is `tmp/search-reliability-report.json`; raw final responses and events
are in `tmp/catalog-vehicle-evaluation/suite-1791042376188/`. Earlier development
runs, including failures that motivated the fixes, are retained in adjacent suite
directories. These checks establish reference identity and review coverage, not
exhaustive palette accuracy. Individual facts can remain unknown or conflicting;
a completed review does not imply confirmation of every field.

Historical successful Brazilian live evaluations before the search scheduling changes:

| Vehicle | Reference found | Time | Estimated/reported AI cost | Final reviews |
| --- | --- | --- | --- | --- |
| Hyundai ix35, silver | Shimmering Silver / N3S | 39.44 s | $0.029630 | 13/13 |
| Hyundai Azera 2017, pearl white | Ice White / WW7 | 38.55 s | $0.034009 | 9/9 |
| Toyota Corolla 2018, pearl white | Branco Lunar / 070 | 36.40 s | $0.014380 | 2/2 |
| Volkswagen Gol 2015, silver | Cinza Platinum / LD7X | 39.47 s | $0.029758 | 11/11 |
| Puma GTS 1978, red | Vermelho Mont Carlo | 38.50 s | $0.038643 | 5/5 |

Puma uses the source's `Mont` spelling. Its OEM code, exact-year availability and
finish remain unconfirmed; no unrelated maker's code is filled in. These runs
passed the explicit reference, catalog-coverage, finish, review-coverage, time and
cost checks saved in `tmp/catalog-vehicle-evaluation/acceptance.json`. This is not
a ground-truth test of every returned paint or exhaustive recall. Every run still
has unknown verification fields. Earlier live attempts included an all-engine
Toyota timeout and a Puma discovery miss; sparse follow-ups now overlap planning.
The live runner exits nonzero when its acceptance checks fail, without retries
that could hide a failed run.

## Run

From the repository root, with the existing dependencies and `.env`:

```bash
node backend_serper_qwen_finish/ai.js
node backend_serper_qwen_finish/ai.js '{"brand":"Hyundai","model":"Azera","automobileType":"car","manufacturingYear":2017,"predominantColor":"branco","paintFinish":"perolizado","country":"Brazil"}'
```

Set `OPENSERP_HOST=127.0.0.1:7000` (an HTTP(S) base URL also works).
Search uses `GET /google/search`, `/bing/search` and `/duckduckgo/search` on that host,
with no search API key required.
`SEARCH_PROVIDER` defaults to `openserp`; remove an older override or explicitly
set `SEARCH_PROVIDER=openserp`. To switch providers, use `SEARCH_PROVIDER=brave`
with `BRAVE_API_KEY`, or `SEARCH_PROVIDER=serper` with `SERPER_API_KEY`.

Model keys: `OPENROUTER_API_KEY` for Qwen/OpenRouter routes and `OPENAI_API_KEY`
for direct OpenAI routes. `GEMINI_API_KEY` enables the final Google page-analysis
fallback. Missing model credentials skip their routes.
Import `AgenticLoop` from this folder's `ai.js` to select this copy in another caller.
Root application entry points are unchanged.

## OpenSERP parallel search

Brazilian searches send `region=BR` without `lang`: OpenSERP translates `lang`
into Google's strict language filter, which would suppress international sources.
Portuguese queries still seek local names. Queries retain international
source terms. Each query requests 10 organic results per engine. Page fetching and
model extraction remain in this backend; OpenSERP's
own page extraction and SERP features are disabled to avoid duplicate work.

The adapter accepts the local service's JSON envelope and older array responses,
normalizing titles, URLs and snippets into the existing research pipeline. Plain
Google, Bing and DuckDuckGo redirect parameters are decoded locally. Opaque `/goto` tokens are resolved
using redirect headers before source ranking and URL deduplication, with eight
concurrent resolutions, a two-second budget and up to four hops per link. Target
page bodies are not downloaded during resolution. Failed resolutions produce
`SEARCH_UNRESOLVED_URLS` warnings; valid peers remain available. Display breadcrumbs
are never guessed into source URLs. Search
concurrency is two per engine, shared across searches in a run. Identical pending
queries and redirects share work. Cancelling one subscriber preserves its peers.
Each HTTP attempt has an eight-second timeout and at most one retry, admitted
only when its wait plus a useful attempt fit the remaining deadline. Retry-After
and engine-specific cooldowns prevent queued calls from immediately repeating a
rate-limit error. Other engines continue independently.
Cancellation, rate limits, invalid responses and service failures retain structured
errors. An engine block stops only that engine's queued work; the others continue.
Missing/invalid host configuration fails before any HTTP call. There is no automatic
switch to a paid search provider. Results are interleaved by rank and deduplicated
by destination URL; the same source found by three engines is still one source.
Each resolved source can start page fetching before its engine's other redirects
finish. Planning can advance after 100 ms of useful results, or after four
seconds without them so deterministic recovery can proceed while engines keep
working. Engine attempts, retries, latency, cache status, source rejections and
relevant-source counts are recorded in the event log. Empty runs distinguish
search timeouts, irrelevant results and source fetch failures.

Final usage reports actual engine queries as `browserUses.openserp` and `total`,
with `engines: { google, bing, duckduckgo }` and `uniqueQueries`. A query submitted
to all three engines counts as three browser uses; HTTP retries do not add uses.
Name clarification counts remain logical queries. Redirect-header
resolution is neither an additional search nor a source-page fetch. Model selection,
per-model usage, source URLs and page-fetch reporting are unchanged. Source fetches
reject unresolved Google navigation URLs and redirects to Google consent/search
pages before model extraction. Administrative notices rank below paint sources.
Initial page reads continue concurrently while the planner starts after at most
1.5 seconds of waiting for early evidence, so a long document cannot consume the
entire follow-up search window.

The reported failed run analyzed a municipal PDF reached through a Google wrapper
(30 segments, 36 model requests). Live inspection confirmed that two saved wrappers
return usable HTTP redirects. A subsequent OpenSERP search returned
`captcha_detected`, so full live precision/latency validation remains blocked by
Google access. The successful benchmarks below predate this switch and used Brave.
At that checkpoint, **195 offline tests** passed, including six new OpenSERP
regressions. Test output: `tmp/openserp-redirect-regression-tests.log`.

## Search depth and AI cost target

Defaults are now 14 research queries (previously 10), 6 name-clarification queries
(previously 4), and 35 ordinary source pages (previously 25), with additional pages
for name clarification. These are budgets, not guaranteed successful fetch counts:
engine availability, relevant results and the 40-second wall-clock allowance still apply.
Names, complete evidence passages and source associations remain available to the
reviewer. Each candidate is reviewed independently; only final code-matching requests are grouped.

`targetAiCostUsd` defaults to **0.06**. A shared budget estimates and reserves each
concurrent model request before admission, then reconciles it with reported usage.
Page extraction/recovery can consume up to 40% of the target, research leaves 20%
for the final code matcher, and unused funds within those limits remain available.
Queued work waits for pending reservations to settle. Exhausted budgets produce
`AI_BUDGET_LIMIT` warnings and partial results; they never silently label unchecked
names as verified. Unknown failed-request usage is conservatively reserved, although
it remains unknown in the public usage report. This is a soft cost target, not a
hard billing cap: actual output tokens, pricing, failures and provider charges vary.
No model has been replaced, and no extra finish agent has been added.

### Multi-engine validation (2026-10-02)

All **204 offline tests** pass, including finish aliases, engine isolation,
progressive results, per-engine counters, budget reservations and fallback admission.

The latest Brazilian 2017 white/perolizado Azera run completed in **36.59 seconds**
for **$0.01808 reported/estimated AI cost**. It submitted 24 actual engine searches
(Google 5, Bing 11, DuckDuckGo 8) and fetched 15 readable pages, versus seven pages
in the user's preceding Google-only run. It retained Ice White / WW7 and a single
Hyper White entry with WW2/WC9/TW3. The source input had 17 planned logical queries;
some queued engine searches were cancelled at the research deadline.

The run remained partial: six extraction warnings and one failed review batch,
plus search deadlines. Higher quotas are implemented, but 35 completed source
reads and complete candidate review are not guaranteed within 40 seconds. The
matcher now receives a nine-second time reserve. An earlier run read 23 pages but
timed out during code matching, motivating this reserve. None of these runs reached
the AI budget guard; they are latency-limited observations, not a $0.06 cost guarantee.

Replaying the user's saved duplicate result also merges Hyper White/Tricoat and
White Crystal/Tricoat while retaining all URLs and code options; Hyper White Cream
stays separate. Artifacts: `tmp/paint-finish-multiengine-matcher-reserve-response.json`,
`tmp/paint-finish-multiengine-matcher-reserve-events.json`, and `tmp/multiengine-tests.log`.

## Paint finish input

`paintFinish` is an optional string, separate from `predominantColor`. The default
CLI sample is a Brazilian 2017 white Azera with `paintFinish: "perolizado"`.
Omitting the field, or passing null/empty/unknown, keeps finish unrestricted.
Numbers, objects and strings longer than 100 characters are rejected before research.
The copied `test_api.js` accepts the key in a direct vehicle body or `{ vehicle: ... }`
and returns HTTP 400 for invalid input.

Common Portuguese/English aliases normalize to `perolizado`, `metálico`, `sólido`,
`fosco`, `acetinado`, `brilhante` and `tricamada`. Compound descriptions such as
`perolizado fosco` retain both constraints. Other descriptions remain available to
the agents as research context, but unsupported finish vocabulary is not treated
as programmatically confirmed evidence.

The field travels through seed/follow-up searches, Portuguese-name research, page
extraction and recovery context, candidate review, database matching, saved debug
inputs and final output. The first three seed queries keep their broad coverage;
the parts query and Portuguese query carry the finish. Model routing is unchanged.
Model-specific palettes outrank redundant
same-site brand indexes; broad references stay eligible.

`paint_finish.js` adds finish judgments to the existing main review call only for
otherwise plausible candidates. Finish evidence must cite the candidate's own
source IDs and name. Unsupported assertions become unknown; invalid citations
trigger the existing model fallback. Finish exclusions are deferred until the
database matcher can cross-check the identified paint.
Unknown or contradictory finishes remain possible candidates at low confidence.
Generic product-range claims, another paint's finish, a paint code alone, and the
requested input do not establish finish. Extraction still reads the complete palette.

Optical effect and surface sheen are separate. Metallic alone does not disprove
pearl; mixed metallic/pearl is possible. Tricoat alone does not prove pearl. The
database lookup stays broad. Code matching establishes identity even for rows with
an incompatible finish; application code then removes only confirmed mismatches.
Unknown database finish does not invalidate an otherwise justified code or color.

`lazzumix_finish.js` reads catalog suffixes such as PEROL/PRL/PEARL, MET and
LISA/LISO/LIS, including punctuation and slash annotations. It cross-checks all
descriptions with the exact same manufacturer and complete code after that identity
is selected by the matcher. A suffix-free row can therefore inherit explicit finish
evidence from another catalog entry. Compound codes are not split for this check.
No finish is guessed from missing suffixes, BASE/(B)/EFEITO/(E), CL/LF/LG/EC, or an
undocumented abbreviation. The database is read-only.

Conflicting catalog rows or disagreement with confirmed web evidence stay in the
list with `finishMatch: "unknown"`. When several codes are plausible, only codes
with an unopposed incompatible finish are removed; the color remains if any code
is compatible or unresolved. Empty/failed database matches preserve unknown
colors. Exclusions and their catalog evidence appear in `database-matching.json`
and `finish_exclusions` progress events. Internal evidence markers do not appear
in the public response.

`finish_research.js` can use up to two existing follow-up search slots for unresolved
finishes, using the full name and observed codes. The local catalog lookup runs
alongside planning; a lookup failure logs a warning and broad research continues.
These queries share the existing page/search quotas, deadline and $0.06 AI budget.
No extra finish-model call is added. The current regression suite has 209 passing
tests (`tmp/finish-filter-full-tests.log`).

The Brazilian Azera live check after adding catalog finish evidence took 37.29
seconds at $0.01646 reported/estimated AI cost (25 engine searches, 13 readable
pages). Noble White/NW was excluded using the same-code `BLANCO LISO/EC` row;
Ice White/WW7 and Hyper White were retained as finish-confirmed. This run was
partial: one review batch and some searches exceeded their deadlines, so it is
not a complete-recall benchmark. Artifacts: `tmp/paint-finish-catalog-finish-response.json`
and `tmp/serper-qwen-finish/c5194496-d92a-4844-8772-ad3fa7a0e5fc/database-matching.json`.

Compact output echoes the normalized constraint in `vehicle.paintFinish`; expanded
output uses `paintFinish`. Colors add `finishMatch: "confirmed" | "unknown"` when
finish was requested. This measures finish evidence, not physical color matching
or exact year availability. Names remain published names, title-cased only after
the agents finish. Sources, per-model usage and the final `fetchedPages` array remain.
No additional finish agent, mandatory model pass or retry loop is introduced.

Technical coat-count suffixes (`Tricoat`, `Tri-Coat`, `Three Coat`, `Tricamada`,
`Bicamada`, etc.) are normalized internally for inventory review and duplicate
comparison. Final output moves finish descriptors into the standardized
`paintFinish` array. Thus Hyper White and Hyper White Tricoat produce one entry
displayed as Hyper White with `paintFinish: ["tricamada"]`. All codes and source
URLs are retained.
The main reviewer and matcher explicitly distinguish finish suffixes from shade
words and versions. Other common finish suffixes already normalize in inventory;
distinctive names such as Galaxy Pearl, Hyper White Cream and Hyper White II remain
intact. Full original labels survive as aliases and source evidence.

## Model order

| Priority | Page extraction and completeness audits | Planner, recovery and code matcher |
| --- | --- | --- |
| 1 | Qwen 3.5 Flash — OpenRouter | GPT-6 Luna — OpenAI |
| 2 | GPT-6 Luna — OpenAI | GPT-6 Luna — OpenRouter |
| 3 | GPT-6 Luna — OpenRouter | GPT-5.6 Luna — OpenAI |
| 4 | GPT-5.6 Luna — OpenAI | GPT-5.6 Luna — OpenRouter |
| 5 | GPT-5.6 Luna — OpenRouter | — |
| 6 | Gemini 3.5 Flash Lite — Google API | — |

Catalog research, individual candidate review, targeted extraction and final
verification use the first column's Qwen-first sequence through its four GPT
fallbacks. Gemini remains a last fallback for page analysis only.

The Qwen model is pinned to `qwen/qwen3.5-flash-02-23`, matching the earlier
extraction benchmarks. `qwen_page.js` adapts requests to OpenRouter Chat Completions,
with reasoning disabled, strict JSON schema, full source text and no truncation
transforms. The four GPT routes use their existing Responses API requests.
The final route uses `gemini-3.5-flash-lite` directly through Google's `generateContent`
API, with minimal thinking and the same full evidence, prompt and JSON schema.
`gemini_page.js` adapts its request and normalizes its response. Qwen and Google
are selected only for `pageAnalysis` operations in `model_router.js`.

Each Qwen and Google HTTP attempt is bounded to eight seconds by default, then the router
tries the next route. A temporary capacity wait over 200 ms also moves to the next
route; if all eligible pools are busy, the existing bounded shared wait applies.
Failures, refusal, truncated output, malformed JSON, invalid source IDs and unsupported
Qwen names trigger fallback. Google output receives the same source checks; an
exhausted chain is reported through the existing partial-page/recovery handling.
Caller cancellation stops the entire chain. Authentication
and billing errors use the existing brief provider circuit to avoid repeated failures.
No extra retry precedes fallback, preserving time for the remaining routes.

The source evidence, segmentation, independent completeness audits, query/page quotas,
Portuguese-name research, hue review, separate code matcher and final deduplication
remain in place. Literal formal names in parentheses are separated from generic
Portuguese hue/finish labels before inventory construction. Distinctive qualifiers
are retained. An empty valid extraction can still be empty; routing is not a guarantee
that all relevant names were discovered.

## Configuration and diagnostics

| Setting | Default | Purpose |
| --- | ---: | --- |
| `QWEN_PAGE_TIMEOUT_MS` | 8000 | Qwen HTTP timeout; `modelRouting.qwenTimeoutMs` overrides it |
| `QWEN_PAGE_TPM` | 1000000 | Local Qwen token ceiling per minute |
| `QWEN_PAGE_RPM` | 300 | Local Qwen request ceiling per minute |
| `QWEN_PAGE_CONCURRENCY` | 20 | Simultaneous Qwen calls per process |
| `GEMINI_PAGE_TIMEOUT_MS` | 8000 | Google HTTP timeout; `modelRouting.geminiTimeoutMs` overrides it |
| `GEMINI_PAGE_TPM` | 200000 | Local Google token ceiling per minute |
| `GEMINI_PAGE_RPM` | 100 | Local Google request ceiling per minute |
| `GEMINI_PAGE_CONCURRENCY` | 10 | Simultaneous Google calls per process |
| `MODEL_ROUTE_CAPACITY_WAIT_MS` | 200 | Admission wait before trying the next route |
| `MODEL_ROUTE_TIMEOUT_MS` | 12000 | Existing maximum per-route HTTP timeout |

These local ceilings do not increase provider account limits. Qwen and Google have
separate scheduler pools; the original OpenAI/OpenRouter pools retain their limits.
Google retry delays also cool down its pool. `modelRouting.geminiApiKey` overrides
`GEMINI_API_KEY`; an empty string explicitly disables the Google fallback.
Provider failures and partial results retain structured search errors, usage and timing.
All reported failed-attempt usage is recorded. Qwen's provider-reported inference cost
is preferred; fallback estimates use $0.065/M input and $0.26/M output, checked
2026-10-01. Google usage is reported separately as provider `gemini`, including cached
input and thinking tokens. Its existing token-price estimate applies. Unreported
failed-request usage remains unknown.

Debug artifacts go to `tmp/serper-qwen-finish/<runId>/`. Progress events identify
route starts, skips and fallback reasons. Final output still includes each color's
sources/codes and per-model usage, compacted only after the agents finish.

## References

- [Qwen model and provider parameters](https://openrouter.ai/api/v1/models/qwen/qwen3.5-flash-02-23/endpoints)
- [OpenRouter Qwen model](https://openrouter.ai/qwen/qwen3.5-flash-02-23)
- [OpenRouter request parameters](https://openrouter.ai/docs/api_reference/parameters)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Google Gemini 3.5 Flash Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Google structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)

Historical notes inherited from the earlier optimized backend remain in `BASELINE.md`;
this file describes the routing active in this copy.

## Paint-finish validation (2026-10-02)

Before the OpenSERP switch, all **189 offline tests** passed. Added coverage includes optional input validation,
finish evidence/citation checks, conflicting sources, names that contain finish
words, database code filtering, compact output, and complete mocked pipelines for
cars, motorcycles, trucks and agricultural machines.

Fresh Brazilian 2017 white Azera searches measured:

| Run | Time | Reported/estimated AI cost | Readable pages |
| --- | --- | --- | --- |
| Original, unrestricted finish | 35.40 s | $0.04643 | 24 |
| Copy, `paintFinish: "perolizado"` | 39.62 s | $0.05800 | 26 |

Both retained Ice White / WW7. Its finish remains unknown in the available evidence.
The copy's successful run was partial: extraction, review and name-resolution
warnings were reported. Another attempt hit the processing deadline during provider
timeouts. These are individual observations, not speed or accuracy guarantees.
The final stricter name-only/conflicting-evidence checks were verified offline and
replayed against the successful run's saved evidence, without another paid search.

Finish handling uses existing calls and budgets. Preferring model-specific pages
reduced the observed finish-run cost from roughly $0.068 to $0.058, but the latter
is still about 25% ($0.012) above this original run. Different search results,
fallbacks and cache hits affect that comparison; cost parity is not established.
Search-provider charges and unreported failed-request usage are excluded.

Artifacts: `tmp/paint-finish-tests.log`, `tmp/paint-finish-baseline-response.json`,
`tmp/paint-finish-finish-response.json`, `tmp/paint-finish-reviewed-evidence.json`
and `tmp/paint-finish-integrity.json`. SHA-256 checks confirm the original backend's
65 files are unchanged.

## Earlier source-backend validation (2026-10-01)

After adding the final Google fallback, all **175 offline tests** passed, including
six-route ordering, page extraction/audits, malformed output, source validation,
timeouts, retry delays and per-model usage. A live API probe with a synthetic
Brazilian Gol source retained all three expected names in 1.14 seconds for an
estimated $0.000478. The preceding five routes were simulated as unavailable;
this verifies the fallback integration, not whole-run speed or broad accuracy.
Artifacts: `tmp/gemini-last-fallback-tests.log` and `tmp/gemini-last-fallback-live.json`.

Earlier baseline validation:

- All **155 offline tests** passed, including the five-route extraction order,
  unchanged main/matcher routing, cancellation, queue saturation, malformed outputs,
  usage accounting, citation checks and formal-name normalization.
- The fixed-source replay retained **55/55 previous names**: ix35 39/39, Gol 8/8,
  CG 160 8/8. The ix35 replay used GPT-6 fallback on its primary pass; Gol and
  CG 160 completed with Qwen. Elapsed extraction times were 18.49, 3.07 and 4.32
  seconds respectively. All passes completed. These are retained-name checks,
  not independently labeled precision scores or latency guarantees.
- The live Brazilian Azera/white run with Brave finished in **31.66 seconds** at
  **$0.049599 reported/estimated AI cost**, returning 11 public entries including
  Ice White/WW7. It remained partial: two extraction warnings, one name-resolution
  warning, and unresolved Ivory Pearl. Fresh sources differ from Serper benchmarks.
- SHA-256 comparison confirmed all **59 files** in `backend_serper_fallback`
  remained unchanged, with no new files added there.

Artifacts: `tmp/qwen-copy-tests.log`, `tmp/qwen-copy-page-replay.json`,
`tmp/qwen-copy-azera.json`, and `tmp/qwen-copy-azera.log`.

## Incomplete names and code associations

Single-word leads and multiword names with dotted initials/truncated words use the
same name-clarification budget. `name_completeness.js` checks for supported full
spellings; the database may suggest search terms but cannot supply research evidence.
Paint codes printed after a name (including headings, table separators and parentheses)
are associated with that name. Years, URL parameters and another paint's suffix row
are not treated as its code.

After the main review, an abbreviated lead can merge into exactly one approved
full-name candidate when both have the same unambiguous source code and compatible
words/abbreviations. The full spelling must occur in the target's approved evidence.
Version words and word order remain significant; code equality alone is insufficient.
The merge keeps every URL and the original source-name/code association for the final
database matcher. It does not increase confidence or establish missing year applicability.
Ambiguous, conflicting or unsupported expansions remain in `research.unresolvedNames`,
even if the reviewer accidentally labels an abbreviation complete.

The saved Azera replay resolves the abbreviated supplier label to Powder White Pearl,
keeps all three sources, and the live final matcher selects database code N2. Other
approved candidates remain available. This is a replay of existing evidence, not a
fresh search or proof of 2017 factory availability. No extra mandatory model pass was
added; existing clarification searches are used when needed. Validation artifacts:
`tmp/name-completeness-tests.log` and `tmp/name-completeness-verified.json`.

## Retrieval reporting in the final response

Both compact and expanded responses include these programmatically computed fields,
including when a run ends with an error:

- `browserUses`: `total` submitted engine search queries, counts by search provider
  (`openserp` when selected, plus `brave`/`serper`), and
  `nameClarification` (a subset already included in the total). Batched queries count
  individually; internal HTTP retries do not add browser uses. For OpenSERP,
  `uniqueQueries` counts logical queries, `engines` breaks down actual submissions,
  and `nameClarification` counts logical clarification queries.
- `browserUses.failed`: started engine searches that ultimately failed or were
  cancelled, including final verification searches. Successful retries, successful
  empty results, and searches skipped before starting do not count as failures.
  Partial URL-resolution warnings with usable results also do not count. Each
  shared search counts once, and page-fetch errors remain separate.
- `pageFetchAttempts`: unique page URLs whose retrieval actually started, including failures.
- `pagesFetched`: pages successfully retrieved with readable text.
- `fetchErrors`: failed page retrievals. A page retrieved through the reader fallback
  counts once as successful; later model-extraction errors are not fetch errors.
- `pagesWithoutText`: retrieved pages without readable text.
- `pagesSkipped`: queued pages not started because insufficient research time remained.
- `pagesCancelled`: started fetches interrupted by the run deadline or cancellation.
  These are reported separately from site errors.
- `pagesPending`: scheduled pages whose fetch status was still pending when the result
  was produced, for example if the run stopped early.
- `fetchedPages`: the **last field**, an array of `{ url, status }` for every requested
  page, including pages that produced no paint candidates and queued pages that were
  skipped. Failed, cancelled and skipped entries also have `error` and, when available,
  `errorCode`. Status is `ok`, `error`, `no_text`, `pending`, `skipped` or `cancelled`.

This reporting is assembled after the agents finish (or the run fails); it is not
included in model inputs and adds no model calls or tokens.

## Page fetch deadlines

Already-discovered pages begin fetching before waiting for all search engines to
finish. Previously that wait could consume the entire research deadline before
the last selected batch started. Each queued fetch now checks the remaining
fetch budget when it acquires a fetch slot. At the default target it starts only
with at least two seconds of fetch time left. Extraction has a separate later
deadline. Direct requests and reader fallback share at most seven
seconds, with shorter request timeouts when less time remains. Retries share that
budget, and cancellation stops both retries and the reader fallback.

Unstarted pages are explicitly reported as skipped, not counted as network
attempts or site failures. A summary warning still marks the result partial.
Genuine HTTP errors, network failures and per-page timeouts remain visible.
The search/page quotas, model routing and AI budget are unchanged. This prevents
futile late work; it cannot make every remote site
respond within the target time.

After this change, 213 regression tests passed (`tmp/page-deadline-full-tests.log`).
The Brazilian Azera live check completed in 34.15 seconds for $0.02333 in reported/
estimated AI usage and read 12 pages. No active page fetch hit the processing
deadline; ten queued pages were explicitly skipped. Search-engine blocks,
search/extraction deadlines and incomplete depth still made the run partial.
Artifact: `tmp/paint-finish-fetch-deadlines-response.json`.

## Separate extraction and recovery deadlines

The default `targetTimeMs` is now **40000**, including the final verification stage. This is a wall-clock allowance, not a
mandatory delay: the pipeline advances as soon as each phase's work completes.
`research_deadlines.js` supplies separate cutoffs from the run start:

| Phase | Default cutoff |
| --- | --- |
| Search and name-clarification searches | About 14.2 seconds |
| Primary page fetching | 18 seconds |
| Primary page extraction | About 21.8 seconds |
| Failed-extraction recovery, then completeness audits | About 23.7 seconds |
| Main review | Up to 33 seconds |
| Final code matcher (overlaps review) | Up to 36 seconds |
| Independent final verification | Up to 40 seconds |

Changing `AgenticLoop({ targetTimeMs })` scales the research cutoffs. Capacity waits
are still reported but no longer pause deadlines by default. Explicitly setting
`pauseForCapacity: true` restores the former behavior for callers that prefer to
wait for account capacity and accept a longer response. Three seconds are reserved after the review cutoff
for final code matching. Provider failures and very short custom targets can still
yield partial results.

Fetched content remains eligible for primary extraction after search/fetch closure.
All primary page passes run before optional completeness audits. Failed primary
segments use the stronger recovery route with its later deadline; recovery runs
before audits. Up to six distinct extracted palettes receive full-text audits,
prioritizing dense catalogs and requiring at least three seconds left to begin.
Identical page content shares a memoized audit result; accounting includes only
incremental usage. Other pages retain their complete primary extraction. The
`audit_summary` event records selection and time deferrals. Likely requested-hue
candidates receive first access to review capacity; other hues still undergo review
and are never automatically excluded merely by name.
Incomplete recovery and skipped/failed audits remain visible as partial-result
warnings. No source text is truncated and no paint-specific exception is added.

The motivating ix35 trace fetched a page containing Shimmering Silver/N3S, but its
extraction began around 17 seconds and was cancelled at the old 21-second shared
deadline. These changes address that general failure path, retaining the main
researcher and final database matcher and the existing $0.06 soft AI budget.

Validation: 218 regression tests passed (`tmp/45s-deadline-full-tests.log`),
including extraction after fetch closure, recovery before audits, deferred audit
usage, cached audit reuse and wall-clock deadlines during capacity waits.

The earlier 45-second Brazilian ix35/prata live run completed in **44.52 seconds** at
**$0.04742 reported/estimated AI cost**, with 27 fetched pages and 28 returned
colors, including **Shimmering Silver / N3S** and **Cinza Titanium / Y6G**.
It remained partial: two primary page extractions and their recoveries missed
their cutoffs, all six selected optional audits were deferred, and three review
batches timed out. The requested-family priority preserved those target candidates
without adding a vehicle/color-specific rule. This is one observed run, not a
guarantee of full recall within 45 seconds. Saved result:
`tmp/ix35-45s-deadlines-response.json`.


## Overlapping review and code matching

`code_match_pipeline.js` starts the final code matcher as soon as a review batch
has validated every decision and citation. Other batches can continue reviewing
at the same time. A batch needing the hue follow-up waits for that check first.
The main researcher, final matcher, model routes, search/page quotas and $0.06
soft AI budget are preserved.

Up to six matching groups run concurrently, using the existing shared model
scheduler and budget reservations. Matches are reused only when the entire final
color object (including name, sources, evidence and finish) is unchanged. A later
alias resolution or changed evidence triggers a fresh match; a stale finish
exclusion cannot remove that revised candidate. All started matching work is
joined before final output and usage totals. Debug matching artifacts now include
`-batch-N` to avoid concurrent batches overwriting each other. The accumulated
`databaseCodeAgent` stage duration can exceed elapsed matching time because
batches overlap; `timing.totalMs` remains the wall-clock measurement.

Validation: **223 tests passed** (`tmp/faster-pipeline-tests.log`), including
actual review/matching overlap, complete source retention, match reuse, invalidation
of stale finish exclusions, and final-output formatting after matching.

Two Brazilian ix35/prata runs (no year or finish restriction):

| Run | Time | AI cost | Readable pages | Colors |
| --- | --- | --- | --- | --- |
| Initial pipeline, four matching groups | 36.36 s | $0.04344 | 33 | 22 |
| Final pipeline, six matching groups | 35.10 s | $0.04004 | 31 | 21 |

Both returned **Shimmering Silver / N3S**. Both remained partial, with search,
extraction/recovery and review cutoffs plus deferred optional audits. Results varied
from the earlier 45-second run: for example, Cinza Titanium was extracted in the
first faster run but rejected by the main reviewer for lacking an ix35-specific
source association. These observations demonstrate lower latency, not identical
recall or a guarantee of completion for every query. Provider timing and local
serialization may also add small overhead beyond the configured deadline.

Saved final ix35 result: `tmp/ix35-pipeline-38s-final-response.json`.

The Brazilian 2017 Azera/branco/perolizado check completed in **37.03 s** at
**$0.041295** with **24 readable pages** and **12 colors**.
Noble White/NW was excluded using the same-code `BLANCO LISO/EC` catalog
evidence. Unknown finishes remained eligible. This run also remained partial;
see `tmp/azera-pipeline-38s-response.json` for colors and warnings.


## Full published suffixes and finish evidence

The complete source wording (Pearl, Metallic, Tricoat, Tricamada, Matte, Solid
and other finish descriptors) remains available internally. The latest output
format moves technical suffixes into `paintFinish`, as documented below. Title
casing still runs after the agents finish. `source_evidence.source_name` carries the original
published label through internal normalization and database matching. Presentation
chooses an existing fuller label; it never invents a combined name from different
sources. Coat-count duplicate comparison still uses a normalized key, independently
of the displayed label.

The reported Pure White result came from a source card actually named **Pure
White Pearl**, with code **N2**. Previously the base name lost Pearl, its removed
suffix was treated as independent finish proof, and the markdown-card code was
missed. Finish validation now removes the complete published aliases before
assessing separate descriptors and checks individual source rows. Adjacent rows
and generic product-range claims cannot supply that evidence. The same check is
used for finish-research planning. Linked code/name cards now yield their code
only when the card's paint name matches the candidate.

Unknown finish remains eligible; confirmed mismatches are still removed only
after the existing evidence/database checks. No new model pass, model change,
search quota or timeout was introduced.

Validation: **227 tests passed** (`tmp/finish-suffix-output-tests.log`). Replaying
the exact saved problematic row produced an unknown web finish, then the live
matcher established **Pure White Pearl / N2** with a database-confirmed finish
in **4.33 s**, costing **$0.000254**. Artifact:
`tmp/pure-white-identity-replay.json`. The separate full Azera live attempt hit
Google 429s and review deadlines and returned no final colors; it is not evidence
of end-to-end recall (`tmp/azera-finish-identity-response.json`).


## Standardized per-color paintFinish

Both compact and expanded outputs now include a `paintFinish` **array** on every
color. Labels are standardized Portuguese values, in stable order:
`sólido`, `metálico`, `perolizado`, `fosco`, `acetinado`, `brilhante`, `tricamada`,
`bicamada`. Multiple descriptors can coexist, for example
`["metálico", "perolizado", "tricamada"]`. Tricamada alone never implies perolizado.
With no supported descriptor the array is `["desconhecido"]`; conflicting
reported finishes produce `["conflitante"]` without removing the color.

The array reports descriptors from published suffixes, paint-specific source
statements and matcher-selected catalog evidence. It does **not** certify them:
`finishMatch` remains the separate, evidence-validated comparison with the user's
requested finish. A name-only Pearl suffix can produce `paintFinish: ["perolizado"]`
while `finishMatch` stays `unknown`. The requested finish is never copied into
this field. Conflicting output evidence downgrades `finishMatch` to `unknown`.

Technical trailing suffixes are removed from the displayed name, after duplicate
merging. Distinctive name words remain: Pearl White is not rewritten to White,
and Galaxy Pearl is not shortened into an ambiguous one-word name. Original
published names remain in debug/source evidence and matcher input.

Example of the database-confirmed N2 identity from the preceding saved replay:

```json
{
  "name": "Pure White",
  "paintFinish": ["perolizado"],
  "finishMatch": "confirmed",
  "codes": ["N2"]
}
```

`paint_finish_output.js` computes this field programmatically after all agents
finish. No additional AI calls, model changes or search budget changes. The
request-level `vehicle.paintFinish` remains the requested constraint. Usage,
per-color sources and page-fetch reporting remain available.

Validation: **234 tests passed** (`tmp/standard-paint-finish-tests.log`), covering
both output formats, suffix-to-field conversion, merged evidence, independent
coat count, missing/conflicting finishes and unchanged input objects. No live
API run was needed for this presentation-only change.


## Final verification agent

`final_verification_agent.js` runs **after** the main researcher, database matcher
and output formatter produce the initial response. The default is one enriched
JSON response when verification ends. `AgenticLoop({ onInitialResponse(snapshot) {
/* publish initial snapshot */ } })` optionally exposes the initial formatted
snapshot before verification; the returned result is the later enriched version.
The CLI continues printing one final JSON object to stdout. Debug files include
`initial-response.json`, verification request/response files, `verification.json`
and the final `response.json`.

Every output color gets its own search for its full name and available codes via
the configured provider (Google, Bing and DuckDuckGo through OpenSERP by default).
It fetches at most two URLs per color, sharing fetches and already fetched content.
If no matching fetched page exists, it also tries the color's original citation.
Matching evidence is selected independently for each color, preferring different
domains without discarding useful pages on the same domain. Model reviews run
individually in parallel. Each color has its own excerpt allowance;
a shared palette cannot consume the last color's space. Search snippets are not proof.
The verifier uses Qwen first, then the original four GPT fallbacks. Main research
and database matching routes remain unchanged. Grouped quoted checks reduce
output-token latency. Search and HTTP failures remain bounded by the shared
40-second wall-clock deadline.

Each color gets a `verification` object:

```json
{
  "reviewed": true,
  "status": "partial",
  "confirmed": ["name", "codes"],
  "conflicting": [],
  "unknown": ["vehicle", "paintFinish"]
}
```

Fields are `name`, `vehicle`, `year`, `codes`, and `paintFinish`; only applicable
fields are checked. The structured response requires a result for every color.
The agent is instructed to evaluate every applicable field; fields without accepted
evidence are marked unknown programmatically. Missing color results trigger the
existing model fallback chain within the remaining deadline and cost budget.
`reviewed` means the agent completed that color's review; it does not mean every
fact was confirmed. Status is `confirmed` only when every applicable field has
support, `partial` when some do, `conflicting` for supported contradictions, or
`unverified` when none were established. Unknown/empty codes are missing data,
not contradictions. A product-name finish suffix alone cannot confirm finish.
Finish checks require a separate labelled specification, with programmatic
compatibility checks. A code confirmation must quote all output alternatives.

Source URLs are appended to a color only for literal, grounded checks referring
to that color. They can support individual facts or document a conflict; they do
not necessarily confirm the entire vehicle/year/finish combination. URL duplicates
are removed. Original candidates, codes and finish fields are preserved even on
verification failure. The agent does not invent replacement database codes or
silently delete unresolved colors.

Top-level `verification` reports `coverage` (`complete`/`incomplete`),
`colorsChecked` (completed reviews), `colorsUnchecked`, and `colorsConfirmed`
(every applicable fact supported). Unknown facts and provider/deadline failures
are never counted as confirmation. It also reports query count, newly fetched pages
and distinct pages successfully reviewed. Existing browser/fetch metrics include
the extra work; `browserUses.finalVerification` counts logical verification queries.
Usage totals and `usage.byModel` include the verifier, and `fetchedPages` remains
the final JSON field. Cached page reuse does not inflate fetch-attempt counts.

The default reserves four seconds of the 40-second allowance after matching,
plus any time the earlier stages save. Main reviews also run one candidate per
call. Ten percent of the existing $0.06 soft budget is reserved for final
verification; it may use any other unspent budget. Set `verification: false` to
explicitly disable this stage. No stage can promise full verification when search
engines or model providers are slow; incomplete checks stay visible.

Earlier Brazilian ix35/prata live validation (no year or finish restriction):
**39.09 seconds**, **$0.02776**, **25 readable pages**, **18 returned colors**.
The final agent ran five grouped searches, independently checked five previously
fetched pages and added **11 per-color source links**. Every color had at least
one checked fact. All remained partially verified: name/code checks succeeded,
but vehicle/year/finish were not universally established. No new page fetch
completed during verification; fresh confirmation searches timed out. Both
**Shimmering Silver / N3S** and **Cinza Titanium / Y6G** remained in the result.
Earlier attempts demonstrate the failure path: unavailable/slow providers can
leave verification entirely unverified while preserving the initial palette.

Artifact: `tmp/ix35-final-verification-final-response.json`.
Regression validation: **248 tests passed** (`tmp/final-verification-tests.log`).

After adding individual searches/evidence allocation and two-color review batches:
**37.10 seconds**, **$0.024954**, **14/14 returned colors reviewed**, zero unchecked.
Each had at least one supported fact; all still had unresolved fields, so
`coverage: "complete"` and `status: "partial"` are deliberately separate.
Fourteen dedicated search queries were submitted, but fresh searches timed out;
the independent agent reviewed eleven previously fetched pages instead.
Artifact: `tmp/ix35-all-color-verification-v2-response.json`.
Regression validation: **252 tests passed** (`tmp/all-color-verification-tests.log`),
including per-color evidence coverage, final partial batches, omitted results,
unknown facts, deadlines and long palettes.


## Earlier efficient-backend checkpoints (historical)

**Current checkpoint (2026-10-06):** the latest eight-vehicle, four-worker live
run found every required reference paint. All candidate reviews and code matches
completed. Two runs met every acceptance check; six did not, chiefly because of
unresolved short paint names or missing provider usage on failed attempts. One
ix35 final-color review also remained unchecked. Wall time was 49–71 seconds;
the combined admission estimates were $0.028–$0.058 per vehicle, while exact
cost was unavailable in six runs. The subsequent offline changes remove
manufacturer-code and product-code artifacts, resolve a source-printed slash
alias, accept a complete name printed in a palette list, and bridge one uniquely
code-linked BASF full name. These changes need another live benchmark. See
`tmp/catalog-vehicle-evaluation/suite-1791292401530-98b1ded5/summary.json`.

**Current changes:** shared review transport slots, lossless catalog transport,
one evidence-ID namespace, reasoning-token allowance for GPT fallbacks, bounded
public-page downloads, overlapping matching/omission audits for settled decisions,
and a period-brochure search that ranks year-matched color charts ahead of
later-year palettes and generic owner manuals.
When a promising result cannot be fetched, a clearly printed two-word paint
name in its vehicle-linked search title remains a low-confidence research lead;
it is not counted as a fetched page. Exact complete catalog names take priority
over near-spelling code matches when the source itself prints no code.
One bounded discovery search can clarify a year-linked paint whose catalog has
competing codes. The final matcher still decides code identity; a code printed
with that paint takes precedence over unrelated catalog matches.
All three catalog lookups, independent final verification and the hard
**20-search-attempt limit including retries** remain in place.
Late name clarification has its own 35-second window for searches, page fetches
and extraction. It prioritizes likely requested-family names without excluding
other names by wording. Supplier code cross-references are identified before
review; complete source-printed names with several code forms stay eligible.
Model capacity admission selects an available fallback immediately. If every
eligible route is busy, it uses one shared wait.
The stable inventory now forecasts its omission-audit reserve. Audit work waits
for full batches during review, while matching can still overlap. A large
budget-rejected verification request splits into smaller independently admitted
children, and unchecked final colors get one bounded retry from the run's
existing evidence. Name clarification can search a two-word suffix of a long,
multiply sourced label, but only independently printed paint names become new
candidates. Live vehicle reports show completed and failed model attempts by
route and stage.
Workflow completion and billing completeness are reported separately.
Search-result `highlight` parameters are removed before indexing and fetching
their canonical page. A failed primary extraction has a bounded recovery window
through 35 seconds rather than inheriting the 17-second extraction cutoff.
Literal recovery also recognizes multi-row, model-labelled `Name (code)` lists;
every recovered candidate still goes through normal review and year checks.
Reader-proxy 403 templates are treated as failed pages, not paint evidence.
Finish-only labels such as `Pearl Met.` and abbreviated generic commercial
shades are removed as non-identities before candidate review.
When a provider omits usage for a started call, exact cost remains `null` and
the response reports a separate `admissionEstimateUsd` from the request budget.
That estimate is not a provider invoice or an upper bound.
Recovery tries shorter independent page segments first. If the cheapest
remaining segment cannot pass cost admission, it retains larger segments as
incomplete rather than repeating futile model attempts. When the shared page
budget is fully spent, other pages skip model recovery too; literal extraction
still reads every failed segment. OpenRouter's specific in-flight credit hold
briefly lowers shared Qwen admission across workers and starts fallback;
genuine account billing failures retain the provider-wide cooldown.
Final palettes above 24 paints use up to six independently identified colors
per verification transport. One correction wave
may retry up to 32 unchecked colors from
the same run-local evidence. Search quotas and source checks remain in place;
the current AI admission target is $0.065.

The next four-worker live check found the required reference in each vehicle.
Cruze completed all review stages in 60.7 seconds; ix35, Corolla and S10 ended
near 98 seconds with unfinished candidate work. All four lacked complete
provider usage and therefore failed the cost acceptance check. The coordinator
recorded 54–58 seconds of capacity waiting for those three cases. After this
check, source recovery was moved to Qwen first and the admission charge for a
specifically identified OpenRouter preflight credit hold was reduced to its
input allowance. A second four-worker check after those changes found only two
of four references, with 98–297 candidates per vehicle and unfinished main
reviews in all four cases. Requested-family main reviews now have shared
capacity priority over broad triage. Main review transport is limited to three
concurrent batches per vehicle, and broad triage to two, so four workers do not
all flood the same Qwen pool. Large GPT review batches have an eight-second
first-content allowance inside their existing attempt deadline. These latest
queue changes have offline tests but no later live result.
The candidate queue also gives source-printed full name/code rows earlier review
within the requested hue family; no candidate is removed by that ordering.
Qwen recovery uses the verbatim-evidence response shape required by that stage;
numeric source-ID instructions remain scoped to page analysis.
Recovery and clarification requests now send explicit output limits, and AI
admission accounts for the Qwen limit actually sent to OpenRouter.
Qwen review batches with more than four candidates request less unused output
capacity, reducing OpenRouter's in-flight credit reservation. The default
shared Qwen ceiling is eight calls, with two slots held from page work for
review and completion. Requested-family reviews now precede newly queued
omission audits, while older audits still gain queue priority with time.
GPT budget admission now includes the reasoning allowance exactly once, using
the same output limit that the provider receives. These changes have only
offline validation in the initial rollout. A subsequent four-worker paid run
found all four required reference colors. Cruze and S10 reviewed their entire
candidate inventories; ix35 and Corolla still had 55 and 135 unreviewed leads.
All four final palettes were verified, but complete cost reporting remained
unavailable because failed model attempts lacked provider usage. End-to-end
time ranged from 67.8 to 82.4 seconds, with 19–43 seconds of capacity waiting.
The combined admission estimates including Serper were $0.0610–$0.0740.
The same run showed OpenRouter returning its account-wide in-flight credit 402
on multiple models. A short account-wide cooldown now skips redundant
OpenRouter fallbacks, and short extraction pages request less unused Qwen output
capacity while retaining their complete source text. Full candidate reviews may
wait up to 500 ms for a busy Qwen slot before using an available GPT fallback;
the wait ends sooner at the review deadline. These last routing changes
have offline tests but no later paid benchmark.
The shared coordinator also reduces admission briefly for a model whose full
first-content window expires without a response. This pressure signal is
limited to that model; a response that was already generating does not trigger
it. The coordinator transport has an offline test for this case.
A second four-worker live check still failed full acceptance despite finding
all four reference paints. Candidate review completed for Cruze, ix35 and S10;
Corolla had 167 unfinished leads. Final verification checked 38/40 Cruze and
30/75 S10 colors. End-to-end times were 70.6–88.0 seconds, and the combined
admission estimates were $0.0724–$0.0773. Very large final palettes now group
up to six separate color decisions per verification transport, with the same
workload splitter and per-color citation checks. This has offline validation
only. Provider usage remained incomplete in every paid run, so exact costs
are unknown.

**Historical validation:** a seven-case checkpoint found **7/7 reference paints**,
with every processing time below 50 seconds, excluding runner admission waits.
The earlier four-worker benchmark found all four references but took 66–71 seconds
with 25–32 seconds of capacity waiting per vehicle. A later immediate-routing
four-worker run reduced capacity waits to 6–20 seconds but took 40–84 seconds,
missed the ix35 reference and completed no full acceptance cases. Later checks
and the remaining offline-only changes are summarized above.
It passed **2/7 under the previous checks**;
none had fully complete processing. The benchmark now also requires
`completion.status === 'complete'`, including name resolution and discovery.
Model-only replays subsequently completed all 310 Corolla reviews in 12.35 s,
Azera's failed White Cream review in 2.08 s, and two failed ix35 matches in 5.70 s.
These isolated checks are not a passing full-request or concurrent-load release.
An earlier offline run passed **536/536 tests** when its worker processes could
start. The latest focused checks pass; a whole-suite invocation still reports
four file-level launch failures that pass when those files run separately. The
complete live vehicle suite and concurrent-load gate remain open.
The subsequent four-worker run completed all candidate, omission and final
review coverage, but all four results retained unresolved paint-name leads and
two unmetered model calls each. Its former Corolla reference, Branco Lunar
(089), was also drawn from a later Toyota palette: the Brazilian 2018 brochure
lists Branco Perolizado (070). The evaluation now requires the 070 pearl-white
identity under its published Brazilian or international full name. Historical
results have not been reinterpreted as passing this corrected check.
One later live Corolla run found the corrected 070 reference and completed all
candidate, omission, code-match and final-review coverage in 69.0 seconds. It
used 14 Serper searches and had a $0.0630 combined admission estimate, but
three model calls lacked usage and the `White (Comm.)` lead left workflow
completion partial. The narrow generic-label filter was added after that run
and has only offline validation. The 50-second soft target and full production
acceptance remain unmet.
Subsequent full Azera and S10 runs retained their required paints in 43.01 s and
48.01 s, but both failed release acceptance. Azera completed all reviews/matches
with unresolved names and missing usage; S10 also left reviews/matches unfinished.
A later full S10 run used the soft 50-second target and completed its candidate,
matcher and final-review coverage in 60.5 s for an estimated $0.0668 including
Serper. It still has unresolved names and a broad historic palette, so it fails
release acceptance. Detailed costs and limitations are in the report below.

**Production status:** experimental. Complete live review coverage and reliable
latency under concurrent load are not yet established. Do not interpret a
returned palette as a guarantee that all eligible paints have been found or all
facts confirmed. Read the response's candidate, omission and final-verification
coverage separately.

See [production hardening and release gates](docs/production-hardening.md) for
changes, all live attempts and remaining limitations. Earlier results are in
[the previous reliability pass](docs/reliability-validation.md) and
[prior reliability benchmarks](docs/prior-reliability-benchmarks.md).

**Start here:** [Run](#run) · [Architecture](#architecture) ·
[Module map](#module-map) · [Configuration](#configuration) ·
[Output and debugging](#output-and-debugging) · [Vehicle tests](#repeatable-vehicle-tests) · [Maintenance](#maintenance)
