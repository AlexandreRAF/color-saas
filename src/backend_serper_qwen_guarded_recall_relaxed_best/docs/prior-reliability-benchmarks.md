# Earlier reliability benchmarks

Historical measurements, before the current reliability fixes.

**Latest changes:** evidence-backed code-label filtering before inventory splitting
and after matching; conservative web/catalog alias review reuse; one completion
repair queue; larger review batches; cached mandatory catalog lookups reused by
the separate matcher. Fixed deadlines reserve final-verification time and include
capacity waits. Expired work is reported as incomplete, never as a successful review.
The **20-search-request limit, including HTTP retries**, remains shared across
all stages. Verification allows six primary queries, two individual identity
fallbacks and twelve new page admissions. See
[Grouped searches](#grouped-searches) and [Page reuse and prefetching](#page-reuse-and-prefetching).
The latest architecture has not been live-benchmarked. Replaying the saved Corolla
palette removed its 13 `TOY-*` artifacts and retained the required named 089/070
references; this is an offline artifact check, not a new precision or latency measurement.

**Last live run (first fixed-deadline implementation):** Corolla took **45.8 s**,
with 8 Serper requests, 23 fetched pages and no `TOY-*` output artifacts. It failed
quality: 98/316 candidates were reviewed and Branco Lunar remained unreviewed.
Known AI/search cost was **$0.034268**, with twelve model attempts missing usage.
Follow-up changes preserve streamed partial decisions, reduce output reservations,
overlap the single repair queue with first-pass reviews, and start Portuguese
searches during extraction. Their saved-page model replays are not fresh-search
or end-to-end benchmarks.

**Latest saved-page review replay:** **314/315 candidates reviewed**, 28 model
attempts, 17.0 s of review with 21 s of discovery assumed already spent. Both
required paint names remained in the reviewed candidates. Prata Lua Nova still
hit the repair deadline. Known review-only AI cost was **$0.025134**, with one
attempt missing usage; this excludes extraction, matching and final verification.
No additional Serper requests were made. The full offline suite passed **458/458**
tests (`tmp/efficient-bounded-final-regressions.log`); this does not establish
complete live review coverage or a successful end-to-end quality benchmark.

**Earlier live run (cap fix, before fixed deadlines):** Corolla took **77.6 s**, with
15 logical browser uses / 16 HTTP attempts, 33 fetched pages and 83 model attempts.
Only 200/324 candidates completed main review. Known AI plus estimated Serper cost
was **$0.063407**, excluding four attempts without usage. Required references
returned, but incomplete reviews, artifacts and latency failed acceptance.

**Last live regression (before the cap fix):** Corolla took **77.0 s**, with
82 browser uses / 85 Serper HTTP attempts. Known AI cost plus estimated search
cost was **$0.127884**, excluding three AI attempts without usage. Required
089/070 references and review coverage passed, but precision remained partial.
Duplicate verification research and automatic finish follow-ups caused the
search increase. That implementation did not meet the time or cost targets.

**Previous changes:** full-request batch sizing, progress-aware streaming timeouts,
one split recovery wave, shared concurrency headroom and protected omission-audit
funds. See [Timeout recovery](docs/timeout-recovery.md). **446 offline tests passed**
(`tmp/efficient-five-final-offline.log`). The subsequent single Corolla run took
**66.4 seconds**, with 240/240 candidate reviews, 210/210 omission checks and
28/28 final-color reviews. Required 089/070 references were present, but final
verification retained unresolved facts and the output retained questionable
names. Two matcher timeouts remained; Qwen had none. Known AI cost plus estimated
Serper cost was **$0.066663**, excluding unknown charges for two timed-out AI calls.
The complete cost and 50-second benchmark did not pass. This measurement predates
the page pool and is not evidence of its performance.

**Previous recovery validation:** discovery recovery, protected completion budgets,
catalog alias grouping and final coverage checks passed **406 offline tests**
(`tmp/efficient-recovery-final-tests.log`). One sequential live pass of all
seven vehicles used **132 Serper credits**, with no search failures or retries,
and cost an estimated **$0.322522 including AI and search**. Six vehicles passed
the exact required-color check; Gol returned LD7X as English “Platinum Gray”
instead of “Cinza Platinum”. Corolla still had 36 unreviewed candidates. Only S10
passed every check, including time; average processing time was **62.0 seconds**.
See [Recovery validation](docs/recovery-validation.md) for the individual results.

**Previous benchmark:** [Shared capacity and load results](docs/scaling-followup.md).
Earlier measurements: [API-call reduction results](docs/api-call-reduction.md).

**Current status:** experimental; complete review coverage and the 50-second
latency target are still unresolved. In the preceding implementation, across two repetitions of all seven vehicles,
concurrency 1 / 2 / 4 produced **49.2 / 54.7 / 48.4 s median processing time**
and **14 / 13 / 13 required-reference passes out of 14**. Some reviews remained
incomplete and individual requests exceeded the cost target. Concurrency 7 was
affected by exhausted Serper credits and is not a clean load comparison.
The historical 40-second and reliable higher-concurrency goals were **not** achieved.
The report includes every run, queue times, costs and version limitations.

