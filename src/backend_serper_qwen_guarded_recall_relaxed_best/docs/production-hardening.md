# Production hardening — 5 October 2026

## Release status

**Not approved for mission-critical deployment.** A difficult vehicle may now
continue beyond the 50-second target, up to a hard 100-second run limit. The
latest live S10 run completed its review, matching and verification coverage,
but kept unresolved names and many historical model colors. Concurrent
production throughput has not been validated on this revision.

Changes are confined to `backend_serper_qwen_efficient`. Other backends, the root
environment, model selection/order and catalog database files are unchanged by
this work. The search ceiling remains 20 HTTP attempts, including retries.

## Soft-target and shared-code follow-up

- The default 50-second target is informational. Fixed stage cutoffs leave room
  for difficult review, matching and verification work until a 100-second hard
  maximum. The vehicle evaluator reports `targetMet` separately from acceptance.
- A shared short code component cannot attach an unrelated multi-code catalog
  row to a paint. A code may still legitimately belong to multiple colors;
  identical codes alone do not merge their names. Explicit source-published
  two-name aliases can merge when their full matched code sets agree.
- The final matcher now checks source-printed long OEM codes against each
  selected catalog row even when the catalog's name is exact. This rejects
  misleading short-component matches such as Cherry Red `WA9088/94` versus
  catalog `94/94AWA90`, while retaining source-printed short aliases such as
  Switchblade Silver `GAN`. Same-color `WA` prefixes and selected concatenated
  numeric/WA aliases are compared without treating a shared code as proof of
  one paint identity. The saved S10 matcher decisions were replayed without
  another search; 18 of 80 selected rows fail the new source-code check.
- A source-published finish suffix now rejects a matcher-selected catalog row
  only when the row's parsed finish is definitively incompatible. For example,
  a solid `ROYAL BLAU LISA` row cannot supply a code to `Royal Blue Metallic`.
  Unknown finish remains eligible. This check retains the paint name when it
  withholds a code and adds no API calls.
- A model-free replay across saved Hyundai, Toyota, Volkswagen, Puma and
  Chevrolet matcher traces checked 848 selected database rows for the seven
  required reference paints. Two incomplete composite `Cinza Platinum` rows
  were withheld, but **all 211 reference groups with selected codes retained
  at least one eligible row**. This is a regression check on saved decisions,
  not a fresh live seven-vehicle acceptance run.
- Same-name candidates with different evidence now keep separate matcher
  decisions. `Pearlcoat` is treated as a finish suffix in the final name and
  finish fields.
- A paid Brazilian Chevrolet S10 2025 run completed in **60.496 s** for
  **$0.066773** estimated total (**$0.052773 AI**, **$0.014 Serper**), with
  **13 browser uses**. It retained Prata Shark and completed 137/137 candidate
  reviews, 98/98 code matches and 97/97 final color reviews. Its completion
  status remains `partial` because six abbreviated names could not be resolved.
  The 97-color output still includes many historic S10 paints from generic
  all-year sources. Report:
  `tmp/catalog-vehicle-evaluation/suite-1791230112799-191ac01d/summary.json`.
  The run is a failed precision/release gate despite meeting time and cost limits.
- The complete offline suite passes **536/536 tests** with no skips or
  cancellations when run outside the sandbox (`node --test
  --test-concurrency=2 tests/*.test.js`). The sandbox intermittently denied
  nested Node worker processes with `EPERM`; those were execution-environment
  failures, not assertion failures.

## Previous follow-up

The previous offline suite passed **527/527 tests** with no skips/cancellations
(`tmp/efficient-release-regressions-v6.log`). The changes below have **not** passed
a complete seven-case release or sustained load evaluation.

### Changes

- Full and hue-triage reviews share ordinary transport slots before batches are
  assembled. This allows six triage batches to overlap useful full reviews while
  keeping their combined ordinary ceiling at eight by default. Completion repairs
  retain separate headroom.
- Review source records and matcher catalog rows use shared column names without
  removing their fields or qualifications. Review passages use one E-ID namespace.
  The prompt explicitly separates K catalog choices from E finish quotations;
  catalog-only finish proof is applied by the matcher, never fabricated as a web quote.
- Omission flags cite at most three relevant passages and one issue per candidate;
  correction still receives all evidence. This bounds verbose citation output.
- A productive stream reaching its absolute limit no longer disables its model
  for other requests. Stalled/idle requests still trigger bounded fallback.
  GPT reviews/matches receive up to six seconds for first content within their
  existing absolute attempt and stage cutoffs. Explicit timeout overrides survive.
- New model attempts require at least 1.5 seconds remaining. The router does not
  shorten the last viable attempt to reserve a fallback that cannot meet that
  minimum. This avoids subsecond paid retry bursts; it does not extend a stage or
  count skipped work as reviewed.
- GPT compact-output caps now include a reasoning allowance (at least 2,048 total,
  or visible allowance plus 1,024). The routed cap reaches cost and token admission
  before the request. Qwen's output allowance is unchanged. A replay exposed a
  414-token incomplete GPT response; reasoning and visible output share that cap,
  as described in the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/reasoning).
- Confirmation searches with less than two seconds remaining are skipped before
  spending credits; existing evidence still receives final model verification.
  `verification.searchesSkippedDeadline` records these skips.
- Default page fetching validates public destinations at socket DNS lookup and
  every redirect. Private/local/reserved addresses and URL credentials are rejected.
  Bodies are bounded at 10 MiB and cancelled on deadline; oversized evidence fails
  explicitly, including reader responses. This does not replace deployment egress
  controls, CPU isolation or equivalent safeguards in custom injected fetchers.
- Vehicle acceptance now requires `completion.status === 'complete'`. The earlier
  gate could pass a reference/review check despite unresolved names or insufficient
  discovery. Historical reports are retained with their original acceptance results.

### Seven-case checkpoint before the last prompt/matcher fixes

Reports: `tmp/catalog-vehicle-evaluation/suite-1791226754256-6b8d7273/summary.json`
(Corolla) and `suite-1791226929305-bcdbe019/summary.json` (other six).

| Vehicle | Time | Searches | Known AI + Serper | Missing usage | Outstanding processing issues |
| --- | ---: | ---: | ---: | ---: | --- |
| Corolla | 42.564 s | 12 | $0.053699 | 0 | Unresolved name |
| ix35 | 46.318 s | 7 | $0.027568 | 11 | Two matches, unresolved names, usage |
| Azera | 44.982 s | 12 | $0.029985 | 4 | White Cream review, unresolved names, usage |
| Gol | 44.792 s | 17 | $0.032842 | 3 | Usage |
| Puma | 31.434 s | 10 | $0.016358 | 0 | Insufficient discovery |
| Cruze | 47.979 s | 13 | $0.046539 | 4 | Unresolved names, usage |
| S10 | 47.182 s | 9 | $0.038347 | 8 | Matching, unresolved names, usage |

**7/7 required references**, all below 50 s, average **43.61 s**. Every final color
was reviewed and every omission audit completed. Six of seven candidate-review
inventories completed; five of seven matching inventories completed. Only Corolla
and Puma passed the previous acceptance gate, and **none** had complete public
processing status. Unknown/conflicting paint facts also remain visible separately.
Corolla overlapped the offline suite during this checkpoint, so its time is not an
isolated-host latency measurement.

These seven checks used **80 Serper attempts**, estimated **$0.080**. The combined
known subtotal is approximately **$0.24534**, excluding missing model receipts.

### Targeted full runs after the prompt/matcher changes

Report: `tmp/catalog-vehicle-evaluation/suite-1791227892404-9d557adb/summary.json`.
These precede the final minimum-attempt-window change above.

| Vehicle | Time | Searches | Main reviews | Matches | Final reviews | Known AI + Serper | Missing usage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Azera | 43.009 s | 12 | 83/83 | 13/13 | 13/13 | $0.029619 | 1 |
| S10 | 48.012 s | 7 | 127/142 | 73/82 | 35/80 | $0.036062 | 20 |

Both required paints returned, and both runs **failed release acceptance**.
Azera completed the review/matching work, including White Cream, but retained
unresolved names and one missing extraction usage receipt. S10 exhausted its
review, matching and final-verification deadlines. Its final palette became
available at approximately 42.2 seconds, leaving only 5.8 seconds to verify 80
colors. All omission audits completed in both runs; this does not compensate for
the other unfinished work. Known costs exclude calls without reported usage.

These two runs used 19 additional Serper attempts ($0.019 estimated). Together
with the checkpoint above, this follow-up used **99 attempts**, with a combined
known AI/search subtotal of approximately **$0.31102**. Complete billing remains unknown.

The tables above report processing time after runner admission. They exclude
waiting behind earlier vehicles: the six-case checkpoint had 263.399 s p95
end-to-end time, and the targeted S10 run took 91.372 s including its runner wait.
These are sequential runner queues, not evidence of a sub-50-second concurrent
service response.

### Saved-evidence diagnostics (zero searches)

| Replay | Result | Model time | Known model cost |
| --- | --- | ---: | ---: |
| Corolla, transport compaction only | 302/310 reviewed, four missing receipts | 19.432 s | $0.020565 |
| Corolla, shared review slots | 310/310 reviewed, complete usage, 19 calls | 12.345 s | $0.022201 |
| White Cream, initial ID change | Still failed: K IDs in E-only field; GPT output cap exhausted | 19.150 s | $0.001081 |
| White Cream, corrected finish prompt | 1/1 reviewed, one Qwen call, complete usage | 2.082 s | $0.000243 |
| ix35, longer first-content allowance alone | Failed, four missing receipts | 12.002 s | $0 known |
| ix35, compact matcher transport | Both matches complete, one GPT call, complete usage | 5.701 s | $0.000888 |
| S10, minimum attempt window, 80 final colors | 56/80 reviewed, eight missing receipts, 22 calls | 5.841 s | $0.004272 |

Artifacts: `tmp/efficient-review-transport-v4.json`, `efficient-review-slots-v4.json`,
`efficient-review-azera-white-cream-v4.json`, `efficient-review-azera-white-cream-v5.json`,
`efficient-matcher-ix35-v4.json`, `efficient-matcher-ix35-v5.json`, and
`efficient-s10-final-window-v6.json` in `tmp/`.
Zero known cost on the failed matcher is **not** zero billed cost. Replays use
saved inputs, warm catalogs and assumed stage start times; they do not prove
end-to-end or concurrent reliability. Matcher outputs were Prata Titanium/T6S
and Bright Silver/SM; receipt completeness alone is not independent identity proof.
The S10 replay assumes 42.2 seconds already elapsed and retains the original
48-second verification cutoff. It still fails coverage and cost completeness;
there has been no fresh full-request or load benchmark after the window change.

## Earlier implemented fixes

- Catalog-reference validation accepts multiple valid formula editions. The
  previous Corolla `Super White` failure was an overrestrictive array limit,
  not simply a provider timeout. Every selected row remains available.
- Batch validation normalizes only unambiguous categorical wrappers and omitted
  optional extractor work. It does not invent names, evidence, finish or approval.
- Uncertain hue triage enters full first-pass review; it no longer spends the
  candidate's one correction allowance before an omission audit can use it.
- Omission audit slots are released before downstream repairs. Two slow repairs
  cannot hold all audit slots and starve untouched candidates.
- Verification retrieval stops at 42 seconds, leaving six seconds until the
  fixed verification cutoff. Transport concurrency respects the Qwen scheduler;
  small palettes use two colors per request, larger ones three. Every identity
  still receives its own decision. Normalized page text is reused within the run
  and invalidated if the text changes.
- Explicit repeated name/code swatches are parsed locally when their headings
  and repeated structure establish the pairing. Source context and unparsed
  qualifications remain available to the agents. This avoids repeated extraction
  of mechanically readable swatches without hardcoded vehicle colors.
- Matching uses one run-local queue, up to eight independent inputs per request
  within the evidence size limit and three active calls. Complete evidence is
  retained and original indices restored. Usage is recorded once per transport.
  Empty catalog choices resolve locally. Invalid/foreign row IDs now trigger
  model fallback instead of silently becoming an apparently successful no-match.
- A reused `AgenticLoop` rejects with `AGENT_ALREADY_USED` before cleanup, so it
  cannot cancel another invocation. Rejected asynchronous progress callbacks
  cannot terminate research.
- Public `completion` and `research.matchingCoverage` distinguish completed
  processing, unknown facts and failed work. Missing diagnostics fail closed.
  Unreported usage remains unknown, never zero. The benchmark requires explicit
  candidate, omission, matcher and final-review coverage and complete costs.

Main review, final code matching and final verification remain separate agents.
All three catalogs, the evidence rules and confirmed-mismatch-only finish
exclusions remain in place.

## Earlier offline validation

**508/508 tests pass**, with no skipped or cancelled tests.

Log: `tmp/efficient-release-regressions-v3.log`.

Coverage includes schema normalization, catalog row ownership, matcher batching
and cancellation, callback isolation, instance reuse, deadline/fallback behavior,
cost accounting, omission scheduling, all three catalogs, source grounding,
shared API capacity and output contracts. Tests use mocked providers; this is
not a production latency or exhaustive paint-accuracy guarantee.

```bash
npm --prefix backend_serper_qwen_efficient test
```

## Live results

These are sequential runs of different intermediate revisions. Fresh search
inventories differ, so timings/call counts do not isolate a single change.
All retain the required reference paints unless stated otherwise. A known
subtotal excludes unreported usage and is **not** a complete billable cost.

### Seven-vehicle checkpoint

Report: `tmp/catalog-vehicle-evaluation/suite-1791218167949-2387add3/summary.json`.

| Vehicle | Time | Search attempts | Known AI + Serper subtotal | Missing usage calls | Acceptance |
| --- | ---: | ---: | ---: | ---: | --- |
| ix35 | 37.592 s | 13 | $0.032402 | 3 | Failed: omission repair, cost |
| Azera | 43.368 s | 12 | $0.029035 | 1 | Failed: cost |
| Corolla | 45.601 s | 14 | $0.045506 | 0 | Failed: omission repair |
| Gol | 46.108 s | 15 | $0.032510 | 10 | Failed: cost |
| Puma | 36.778 s | 10 | $0.019397 | 0 | Passed checkpoint checks |
| Cruze | 48.008 s | 15 | $0.043704 | 22 | Failed: omission repair, final reviews, cost |
| S10 | 48.005 s | 13 | $0.048546 | 18 | Failed: final reviews, cost |

**7/7 required references and candidate-review coverage passed; 1/7 overall.**
This checkpoint preceded the final matching-coverage assertion and later fixes.
It is not a passing release benchmark for the final revision.

### Targeted checks after the review/verification fixes

Report: `tmp/catalog-vehicle-evaluation/suite-1791219989167-55363ff0/summary.json`.

| Vehicle | Time | Candidate reviews | Final reviews | Search attempts | Known subtotal | Missing usage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Corolla | 46.022 s | 305/305 | 9/9 | 9 | $0.050024 | 5 |
| Cruze | 45.281 s | Complete | 70/70 | 15 | $0.051243 | 3 |
| S10 | 48.010 s | 128/130 | 74/83 | 13 | $0.044720 | 16 |

Corolla and Cruze passed the then-current reference/review/omission/time checks,
but failed cost acceptance. S10 also failed candidate/final review coverage.
These runs preceded the shared matcher transport and matching-coverage gate.

### Earlier S10, after shared matcher transport

Report: `tmp/catalog-vehicle-evaluation/suite-1791222354914-75fc49fe/summary.json`.

- Time: **47.950 seconds**; required **Prata Shark returned**.
- Candidate reviews: **87/87**; final-color reviews: **56/56**.
- Code matching: **52/57 completed**, five incomplete.
- Omission audit: **30/30 checked**, three recovered, one repair failed.
- Search attempts: **13**; six failed/cancelled browser uses.
- Actual model attempts: **89**. Known AI subtotal: **$0.035427**; estimated Serper:
  **$0.013000**. Combined known subtotal: **$0.048427**.
- **Nine attempts omitted usage, so complete AI/total cost is null.**
- Overall acceptance **failed** on matching, omission repair and cost. Names
  remain unresolved as well. No output color was confirmed in every fact field.

This is improved candidate/final-review coverage, not proof of mission-critical
readiness. The full seven-case suite and concurrent load have not been rerun
after the last matcher changes.

An earlier single Corolla diagnostic also failed (313/314 candidate reviews,
10/10 final reviews, 45.161 s; known subtotal $0.055692, one missing usage call):
`tmp/catalog-vehicle-evaluation/suite-1791217844965-350fbd6a/summary.json`.

These twelve full live runs used **151 Serper HTTP attempts**, estimated at
**$0.151**. Their combined known AI/search subtotal was **$0.501206**; ten runs
had incomplete cost accounting, so this is not the complete billed total.

## Saved-evidence model checks

These use paid models but **zero Serper requests or downloads**. They isolate
verification with the stated remaining deadline, not full-request behavior.

| Replay | Assumed elapsed time | Reviewed | Verification time | Cost |
| --- | ---: | ---: | ---: | ---: |
| Cruze, 50 colors | 40.0 s | 50/50 | 5.418 s | $0.005399, complete |
| S10, 61 colors | 40.0 s | 61/61 | 5.917 s | $0.005594, complete |
| S10, experimental four-color batches | 41.111 s | 65/83 | 6.907 s | $0.005183 known, six missing usage calls |

The last experiment failed and was **reverted**. Current larger-palette batches
remain three colors. Artifacts: `tmp/efficient-production-cruze-verification.json`,
`tmp/efficient-production-s10-verification.json`, and
`tmp/efficient-production-s10-83-verification.json`.

## Integration and remaining release gates

### Follow-up hardening and latest measurements

Further changes in this directory:

- Ordinary scheduler jobs are counted separately from completion jobs. Reserved
  completion slots no longer cause idle capacity to be counted twice.
- Production mode requires shared capacity and admits one active vehicle by
  default. Seven simultaneous mocked vehicles produce one admission and six
  retryable rejections before paid work. Separate socket clients enforce the
  same limit. This does not claim seven successful concurrent requests.
- Matcher validation retains successful siblings and retries only unfinished
  decisions. Unsupported paint-version changes are rejected. Qwen-first matching
  remains an opt-in experiment, not the default route.
- An independently supported omission dispute gets one factual correction even
  after a prior format correction. It receives the actual disputed passages and
  all catalog choices. The audit queue now forms batches only when a transport
  slot opens; downstream repairs do not hold those two slots. The final join
  waits for jobs started as slots reopen.
- Code-prefixed gallery headings use a separately printed exact code/name row
  from the same fetched page. The complete finish-bearing alias and code row are
  retained. Corolla's `040 Super White`/foreign-code artifact was reproduced and
  fixed; no number-only heuristic was added.
- Other-make catalog choices require candidate-owned donor evidence even when
  the requested maker has no row. Navigation menus listing manufacturers cannot
  establish that connection.
- Repeated gallery name/year captions are parsed locally with their complete
  sections and qualifications. A saved S10 page retained 56 names while reducing
  extraction input from 18,932 to 3,646 characters. Both extraction modes retain
  these candidates when the residual model returns no paints.
- Portuguese display labels may come from actual Lazzumix rows only when the
  complete normalized vocabulary, manufacturer, matched code and compatible
  finish evidence agree. Versions and distinctive words are preserved. Original
  names remain aliases and the catalog row's provenance reaches final verification.

The latest seven-case checkpoint, **before the final audit-queue/localization
changes**, is `tmp/catalog-vehicle-evaluation/suite-1791224666913-7b6b3af3/summary.json`.

| Vehicle | Time | Serper attempts | Known AI + search | Missing usage | Acceptance |
| --- | ---: | ---: | ---: | ---: | --- |
| ix35 | 36.858 s | 13 | $0.034820 | 0 | Passed |
| Azera | 31.691 s | 12 | $0.026499 | 0 | Passed |
| Corolla | 45.087 s | 9 | $0.051917 | 0 | One omission audit incomplete |
| Gol | 44.798 s | 15 | $0.032227 | 6 | Portuguese name, matching, cost |
| Puma | 22.015 s | 9 | $0.012879 | 1 | Cost |
| Cruze | 46.600 s | 13 | $0.035882 | 4 | Cost |
| S10 | 48.008 s | 15 | $0.052583 | 11 | Matching, final reviews, cost |

Gol returned the correct Platinum Gray/LD7X identity but failed the required
Portuguese name check. Six of seven reference checks passed. Every candidate
received its main review. S10 still had ten unfinished matches and 18 unfinished
final reviews. Unknown usage is excluded from the known subtotal.

**Latest revision, targeted checks:**
`tmp/catalog-vehicle-evaluation/suite-1791225302019-38adee4b/summary.json`.

- Gol: **36.916 s**, Cinza Platinum returned; all color, catalog, candidate,
  omission, matcher and final-review checks passed. One missing usage receipt:
  known subtotal **$0.028409**, complete cost unknown; overall acceptance fails.
- Corolla: **46.185 s**, Branco Lunar/089 and pearl-white/070 returned, no solid
  finish leaked, matching/final reviews completed. Provider timeouts consumed
  budget reservations; candidate/omission review remained incomplete. Twelve
  missing usage receipts; known subtotal **$0.039094**, complete cost unknown.

Earlier intermediate checks in this follow-up are retained in
`suite-1791223469756-cc977b29` and `suite-1791224016500-d0d3931e` under the same
report directory. Across these **13 follow-up full runs**, Serper used **159
HTTP attempts** (estimated **$0.159**); combined known AI/search cost was
**$0.503432**, excluding unreported usage. Paid reruns stopped after the targeted
checks to avoid further search-credit consumption.

Model-only diagnostics used zero searches. A Gol matcher replay returned its two
codes in 2.439 s for $0.000058 with a warm provider prompt cache. It completed
within the original first-content limit, so it does not justify extending that
limit or establish cold/concurrent performance. Saved Qwen/GPT matcher trials
likewise do not establish a precision-equivalent replacement. The replay tool is
`evaluate_saved_matching.js --live-models INPUT OUTPUT [--gpt|--qwen]`.

The final revision has **not passed a fresh seven-case release or sustained
concurrent-load evaluation**. Required paint references are minimum recall
checks, not exhaustive palette or physical-match guarantees.

1. **Respect the result contract.** `completion.status === 'complete'` means
   required processing finished. It does not mean all paint facts are confirmed.
   Show each color's unknown/conflicting verification facts. A partial response
   may be useful for manual comparison, but must not masquerade as a fully
   completed job. The initial callback is never the verified final response.
2. **Share account capacity.** Multiple processes must use the same
   `CAPACITY_SOCKET` coordinator. Separate coordinators do not share limits.
   Configure real account quotas and put bounded admission/backpressure at the
   future API boundary; adding workers cannot create provider capacity.
3. **Resolve the measured failures.** Large palettes still suffer unfinished
   review/matching work when provider fallbacks consume time and reserved funds.
   Some attempts do not report usage, and some identities remain unresolved.
   Do not weaken gates, infer missing facts or erase these diagnostics to pass.
4. **Validate the complete release.** Require the offline suite, every vehicle
   case, and sustained concurrent-load checks on the intended account/host.
   Measure end-to-end latency including admission wait and complete AI/search
   costs. Small reference tests establish minimum recall, not exhaustive palette
   correctness. An independently reviewed broader vehicle set is still needed.

The current CLI/module is not a deployed production API. This work does not
claim service availability, arbitrary-concurrency latency or perfect paint
identification.
