# Shared capacity and overlapping verification

## Status

Implemented in `backend_serper_qwen_efficient`; the original backend is unchanged.
This remains experimental: the live tests do **not** establish reliable 40-second
latency, complete reviews, or consistent required-color recall under load.

## Changes

1. Start confirmation searches/downloads when stable main reviews approve colors.
   Final AI verification still follows matching and omission repair. A changed
   identity gets its own evidence; prefetched data never counts as approval.
2. Let uncertain candidates return a full decision in their first review batch,
   alongside short supported exclusions, avoiding a separate triage/full-review pair.
3. Reuse identical extraction sections within one vehicle run. Vehicle, text,
   scope and finish changes prevent reuse; quotes are restored against each page.
4. Coordinate separate workers through one Unix-socket admission service for
   model, search and page-fetch capacity. Fair admission, aging, reserved model
   capacity and existing bounded retries remain active. A lost coordinator fails
   explicitly; it never silently restores independent account quotas.
5. Add a repeatable load runner with a separate process per vehicle and reports
   that include runner admission wait, API waits, costs, coverage and failures.

No persistent search/result cache was added. Main researcher, code matcher and
final verifier remain separate; all three catalogs remain mandatory.

## Live benchmark

Command: `node backend_serper_qwen_efficient/evaluate_load.js --levels=1,2,4,7 --repeat=2`.
Each level contains two runs of each of the seven Brazilian vehicle cases.
One coordinator stayed alive across all levels. The run finished on 2026-10-04
America/Sao_Paulo (2026-10-05 UTC). Raw report:
`tmp/catalog-load-evaluation/load-1791158339525/summary.json`.

**Serper credits were exhausted during concurrency 7.** Six runs explicitly
failed the credit-availability check, and other overlapping runs also had search
failures. Treat the entire level as credit-affected, not a clean load comparison.
Failed and partial runs remain included; no extra funded rerun was performed.

| Workers | All checks | Required references | Complete reviews | Median / p95 processing | Mean cost | Maximum cost | Level total |
|---|---|---|---|---|---|---|---|
| 1 | 4/14 | 14/14 | 11/14 | 49.2 / 95.1 s | $0.051468 | $0.095637 | $0.720549 |
| 2 | 2/14 | 13/14 | 11/14 | 54.7 / 93.3 s | $0.051713 | $0.085079 | $0.723981 |
| 4 | 3/14 | 13/14 | 12/14 | 48.4 / 94.0 s | $0.049391 | $0.079238 | $0.691470 |
| 7 | 1/14 | 11/14 | 10/14 | 51.7 / 137.6 s | $0.040780 | $0.081764 | $0.570919 |

Total estimated AI + Serper cost: **$2.706919** for 56 runs.
Costs are estimates, not reconciled provider invoices; failed model requests may
be billed without returned usage. Averages include failed/partial runs and do not
establish a per-success cost ceiling. A passing reference check establishes the
minimum expected colors, not complete palette accuracy. Complete review coverage
does not mean every year, finish or applicability fact was confirmed.

### Queue time and API work

All 14 jobs are submitted together at the start of each level. Processing time
includes model-capacity waits; end-to-end time additionally includes runner queue
wait and worker startup. For 14 observations, nearest-rank p95 is the maximum.
These heterogeneous samples are not a production latency percentile.

| Workers | Median / p95 end-to-end | Median runner wait | Model HTTP attempts | Input / output tokens | Fallback events | Search HTTP attempts |
|---|---|---|---|---|---|---|
| 1 | 408.3 / 767.7 s | 371.3 s | 746 | 4,527,339 / 353,033 | 19 | 291 |
| 2 | 242.1 / 409.9 s | 214.2 s | 750 | 4,800,465 / 322,652 | 26 | 285 |
| 4 | 123.9 / 201.8 s | 52.9 s | 639 | 3,982,657 / 296,907 | 61 | 286 |
| 7 | 75.6 / 138.4 s | 0.1 s | 458 | 2,862,161 / 202,224 | 252 | 254 |

Fallback events include capacity skips, HTTP timeouts and invalid responses;
not every fallback sends an HTTP request. At concurrency 4, 41 of 61 fallbacks
were route admission timeouts and 13 were request timeouts.
The saved `searchRetries: 0` fields are incomplete instrumentation: Serper did not
emit retry events in this benchmark version. HTTP attempt counts above are the
accounted counts and include retries. Retry-event reporting was added afterward;
do not interpret the historical zero fields as proof of no retries.

### Findings and limits

- Corolla exhausted review capacity/budget in both repetitions at every level.
  Serial inventories contained 337–376 candidates; only 170–188 were reviewed.
  Earlier verification networking cannot remove this main-review workload.
- One serial Cruze run cost $0.095637 and took 95.1 seconds; average costs hide
  request-level overages. Starting searches before the final palette is fixed
  can spend search credits on colors later removed.
- Puma at concurrency 2 returned no candidates once. Search results were present,
  but only four selected pages were fetched: two failed and two yielded no paint
  candidates. There was no recorded model-capacity wait for that run.
- Azera at concurrency 4 missed its required reference once. Corolla at
  concurrency 7 also missed a reference, while searches were credit-affected.
- Section reuse is conservative. Its presence is not evidence of measured savings;
  no controlled before/after benchmark isolates the effect of each change.
- The coordinator is for workers on one host. It does not coordinate multiple
  machines or unrelated processes using the same credentials without the socket.
  Restarting it clears local admission history; stop/drain workers first.

### Every paid run

Costs below include Serper. Refer to the raw response and events in each
`concurrency-N/<case>-<repeat>/` directory for colors, sources and model details.

| Workers | Vehicle | Repeat | Processing | Model calls | AI cost | Serper cost | Total | Failed checks |
|---|---|---|---|---|---|---|---|---|
| 1 | ix35 | 1 | 47.5 s | 51 | $0.026547 | $0.017000 | $0.043547 | deadline |
| 1 | ix35 | 2 | 49.8 s | 49 | $0.024324 | $0.017000 | $0.041324 | deadline |
| 1 | azera | 1 | 55.4 s | 44 | $0.025960 | $0.016000 | $0.041960 | deadline |
| 1 | azera | 2 | 46.9 s | 48 | $0.026718 | $0.016000 | $0.042718 | deadline |
| 1 | corolla | 1 | 88.3 s | 78 | $0.054378 | $0.021000 | $0.075378 | everyCandidateReviewed, omissionReviewComplete, deadline |
| 1 | corolla | 2 | 79.6 s | 85 | $0.052799 | $0.023000 | $0.075799 | everyCandidateReviewed, omissionReviewComplete, deadline |
| 1 | gol | 1 | 36.5 s | 32 | $0.018637 | $0.019000 | $0.037637 | None |
| 1 | gol | 2 | 39.1 s | 32 | $0.016551 | $0.020000 | $0.036551 | None |
| 1 | puma | 1 | 37.0 s | 18 | $0.010089 | $0.012000 | $0.022089 | None |
| 1 | puma | 2 | 33.3 s | 24 | $0.010641 | $0.013000 | $0.023641 | None |
| 1 | cruze | 1 | 95.1 s | 89 | $0.056637 | $0.039000 | $0.095637 | omissionReviewComplete, deadline, cost |
| 1 | cruze | 2 | 49.2 s | 71 | $0.038271 | $0.029000 | $0.067271 | deadline |
| 1 | s10 | 1 | 52.5 s | 56 | $0.031866 | $0.024000 | $0.055866 | deadline |
| 1 | s10 | 2 | 49.2 s | 69 | $0.036131 | $0.025000 | $0.061131 | deadline |
| 2 | ix35 | 1 | 54.7 s | 53 | $0.026053 | $0.017000 | $0.043053 | deadline |
| 2 | ix35 | 2 | 54.0 s | 52 | $0.024759 | $0.018000 | $0.042759 | deadline |
| 2 | azera | 1 | 65.1 s | 47 | $0.029458 | $0.015000 | $0.044458 | deadline |
| 2 | azera | 2 | 80.3 s | 53 | $0.036066 | $0.014000 | $0.050066 | deadline |
| 2 | corolla | 1 | 93.3 s | 76 | $0.049944 | $0.023000 | $0.072944 | everyCandidateReviewed, deadline |
| 2 | corolla | 2 | 83.8 s | 79 | $0.053358 | $0.022000 | $0.075358 | everyCandidateReviewed, deadline |
| 2 | gol | 1 | 27.4 s | 32 | $0.016160 | $0.022000 | $0.038160 | None |
| 2 | gol | 2 | 41.4 s | 34 | $0.018430 | $0.025000 | $0.043430 | deadline |
| 2 | puma | 1 | 14.1 s | 2 | $0.000467 | $0.010000 | $0.010467 | successful, referenceFound, allCatalogsQueried, everyFinalColorReviewed |
| 2 | puma | 2 | 32.8 s | 20 | $0.010223 | $0.012000 | $0.022223 | None |
| 2 | cruze | 1 | 70.8 s | 70 | $0.042093 | $0.031000 | $0.073093 | deadline |
| 2 | cruze | 2 | 61.9 s | 88 | $0.051438 | $0.027000 | $0.078438 | deadline |
| 2 | s10 | 1 | 45.0 s | 51 | $0.025453 | $0.019000 | $0.044453 | deadline |
| 2 | s10 | 2 | 56.8 s | 93 | $0.055079 | $0.030000 | $0.085079 | deadline, cost |
| 4 | ix35 | 1 | 46.5 s | 52 | $0.025790 | $0.018000 | $0.043790 | deadline |
| 4 | ix35 | 2 | 52.3 s | 48 | $0.031915 | $0.017000 | $0.048915 | deadline |
| 4 | azera | 1 | 48.4 s | 28 | $0.016480 | $0.018000 | $0.034480 | referenceFound, deadline |
| 4 | azera | 2 | 63.8 s | 35 | $0.027944 | $0.018000 | $0.045944 | deadline |
| 4 | corolla | 1 | 94.0 s | 73 | $0.053238 | $0.026000 | $0.079238 | everyCandidateReviewed, omissionReviewComplete, deadline |
| 4 | corolla | 2 | 86.6 s | 83 | $0.052138 | $0.026000 | $0.078138 | everyCandidateReviewed, deadline |
| 4 | gol | 1 | 34.3 s | 28 | $0.016524 | $0.021000 | $0.037524 | None |
| 4 | gol | 2 | 44.3 s | 30 | $0.019365 | $0.020000 | $0.039365 | deadline |
| 4 | puma | 1 | 35.5 s | 19 | $0.010246 | $0.012000 | $0.022246 | None |
| 4 | puma | 2 | 33.9 s | 20 | $0.009710 | $0.012000 | $0.021710 | None |
| 4 | cruze | 1 | 60.1 s | 58 | $0.040545 | $0.031000 | $0.071545 | deadline |
| 4 | cruze | 2 | 64.8 s | 59 | $0.036184 | $0.026000 | $0.062184 | deadline |
| 4 | s10 | 1 | 50.7 s | 65 | $0.041563 | $0.024000 | $0.065563 | deadline |
| 4 | s10 | 2 | 47.2 s | 41 | $0.023828 | $0.017000 | $0.040828 | deadline |
| 7 | ix35 | 1 | 74.9 s | 57 | $0.032405 | $0.022000 | $0.054405 | deadline |
| 7 | ix35 | 2 | 48.1 s | 48 | $0.024157 | $0.016000 | $0.040157 | deadline |
| 7 | azera | 1 | 63.6 s | 22 | $0.017673 | $0.019000 | $0.036673 | deadline |
| 7 | azera | 2 | 71.3 s | 33 | $0.040210 | $0.017000 | $0.057210 | deadline |
| 7 | corolla | 1 | 99.7 s | 55 | $0.055764 | $0.026000 | $0.081764 | referenceFound, everyCandidateReviewed, omissionReviewComplete, deadline, cost |
| 7 | corolla | 2 | 137.6 s | 52 | $0.056058 | $0.021000 | $0.077058 | everyCandidateReviewed, omissionReviewComplete, deadline |
| 7 | gol | 1 | 58.0 s | 24 | $0.015214 | $0.023000 | $0.038214 | deadline |
| 7 | gol | 2 | 39.6 s | 30 | $0.034561 | $0.014000 | $0.048561 | None |
| 7 | puma | 1 | 8.3 s | 2 | $0.002575 | $0.005000 | $0.007575 | successful, searchCreditsAvailable, referenceFound, allCatalogsQueried, everyFinalColorReviewed |
| 7 | puma | 2 | 10.7 s | 3 | $0.001003 | $0.006000 | $0.007003 | successful, searchCreditsAvailable, referenceFound, allCatalogsQueried, everyFinalColorReviewed |
| 7 | cruze | 1 | 53.3 s | 47 | $0.045025 | $0.007000 | $0.052025 | searchCreditsAvailable, deadline |
| 7 | cruze | 2 | 25.2 s | 12 | $0.006154 | $0.003000 | $0.009154 | searchCreditsAvailable |
| 7 | s10 | 1 | 36.1 s | 17 | $0.009728 | $0.003000 | $0.012728 | searchCreditsAvailable |
| 7 | s10 | 2 | 51.7 s | 56 | $0.038392 | $0.010000 | $0.048392 | searchCreditsAvailable, deadline |

## Validation/version boundary

All **394 offline regression tests passed**. Results are recorded in
`tmp/efficient-scale-final-tests.log`.
The paid suite preceded the final defensive guard against invalid cached evidence
IDs and Serper retry-event instrumentation. Those changes add no model/search
calls on normal successful paths; they were covered by offline regression tests,
not another paid benchmark. Earlier observer/cancellation/name-ownership guards
were completed during the serial level; this is a diagnostic suite, not a frozen
controlled performance experiment.

For coordinator setup, configuration and repeatable test commands, see the
[README](../README.md#shared-capacity-across-worker-processes).
