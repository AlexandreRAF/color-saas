# Recovery validation — 4 October 2026

## Scope

One sequential run per vehicle in `backend_serper_qwen_efficient`, after Serper
was refilled. No paid reruns or concurrency benchmark were performed. The
original `backend_serper_qwen_models` remained unchanged against the saved
114-file hash manifest.

Command, from the repository root:

```bash
node backend_serper_qwen_efficient/evaluate_vehicles.js puma azera corolla ix35 gol cruze s10 --concurrency=1 --repeat=1
```

Raw results, full palettes and events:
[`summary.json`](../../tmp/catalog-vehicle-evaluation/suite-1791162780309-b00d671d/summary.json).
Runner output: [`efficient-recovery-live.log`](../../tmp/efficient-recovery-live.log).
The suite exited with status 1 because six cases failed at least one check.

## Results

Times below are individual processing times. The runner's end-to-end and queue
fields include waiting behind earlier vehicles in this intentionally sequential
suite; they are not concurrent API latency measurements.

| Vehicle | Time | AI cost | Serper cost / credits | Total cost | Model attempts | Candidate reviews | Failed checks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Puma GTS 1978 | 44.5 s | $0.016986 | $0.012 / 12 | $0.028986 | 30 | 64/64 | Time |
| Azera 2017 | 51.7 s | $0.022061 | $0.014 / 14 | $0.036061 | 38 | 80/80 | Time |
| Corolla 2018 | 137.6 s | $0.052688 | $0.023 / 23 | $0.075688 | 80 | 200/236 | Candidate reviews, time |
| ix35 | 47.3 s | $0.024340 | $0.019 / 19 | $0.043340 | 49 | 95/95 | Time |
| Gol 2015 | 50.3 s | $0.020006 | $0.022 / 22 | $0.042006 | 34 | 53/53 | Portuguese reference name, time |
| Cruze 2018 | 64.3 s | $0.036496 | $0.026 / 26 | $0.062496 | 66 | 119/119 | Time |
| S10 2025 | 38.5 s | $0.017945 | $0.016 / 16 | $0.033945 | 37 | 60/60 | None |
| **Total** | | **$0.190522** | **$0.132 / 132** | **$0.322522** | **334** | **671/707** | |

All costs are application estimates, not an invoice reconciliation. Serper uses
the configured $1 per 1,000 credits. All 132 responses succeeded; there were no
search retries or unconfirmed search requests. No additional paid calls were
made to investigate the results.

Every request met the configured $0.06 AI and $0.08 total cost checks. Average
processing time was 62.0 seconds, median 50.3 seconds. Only S10 met the
40.5-second test allowance. All runs reported zero account capacity wait time.

## Required colors and review coverage

- Puma: Vermelho Mont Carlo returned; its code remained unknown.
- Azera: Ice White / WW7 returned.
- Corolla: Branco Lunar / 089 and the separate pearl-white / 070 identity returned.
- ix35: Shimmering Silver / N3S returned.
- Gol: Platinum Gray / LD7X returned. The expected Portuguese name, Cinza Platinum,
  did not, so the existing exact-name check correctly remains failed.
- Cruze: Prata Switchblade returned.
- S10: Prata Shark returned.

All candidates were queried against all three catalogs in every run. All 169
output colors received a final review, and omission-review coverage was complete
in every case. However, all seven final verification summaries were partial:
review completion does not mean every year, code, finish and applicability fact
was confirmed. The pearl-finish cases passed the check against confirmed solid
outputs. These checks measure minimum reference coverage, not full palette
precision or recall.

## Remaining failures

**Corolla review workload:** discovery produced 236 candidates and the safe
catalog grouping retained 236 review groups. Reviews began about 38 seconds
after the run started. Several review batches took 11–14 seconds each. The
completion repair attempted 56 candidates and recovered 48, but AI budget
admission still left 36 candidates without decisions. Protected completion
funds preserved final verification and matching; they did not make all reviews
fit. The budget remained below $0.08, but the quality and latency goals failed.

**Gol localization:** the inventory contained “Platinum Gray” and its English
aliases, and the final output retained that name with LD7X. This is a Portuguese
name coverage failure, not absence of the LD7X identity. The test was not relaxed
to hide the failure.

**Latency:** six of seven runs exceeded the target even sequentially, despite
zero Serper failures and zero reported account capacity wait. Discovery,
extraction and subsequent review/repair work remain too long. No claim of
scalability improvement can be made from this single sequential pass.

## Recorded model usage

| Provider / model | Calls with usage | Input tokens | Output tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: |
| OpenRouter / Qwen 3.5 Flash 02-23 | 297 | 1,900,447 | 143,221 | $0.160767 |
| OpenAI / GPT-6 Luna | 31 | 126,859 | 9,116 | $0.028125 |
| OpenRouter / GPT-6 Luna | 1 | 11,058 | 495 | $0.001630 |

There were 334 route attempts but 329 calls with returned usage. Failed or timed
out calls may lack provider usage; reported cost is therefore an estimate. The
raw per-vehicle JSON retains the usage breakdown and all diagnostics.
