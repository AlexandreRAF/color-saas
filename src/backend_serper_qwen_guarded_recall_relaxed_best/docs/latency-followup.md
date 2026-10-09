# Corolla and Cruze latency follow-up

This change is confined to `backend_serper_qwen_efficient`. The original
`backend_serper_qwen_models` remains unchanged. No persistent result cache,
model replacement or increased provider concurrency was introduced.

## Changes

1. **Stop quota-filling discovery.** After the initial broad searches, sufficient
   paint coverage requires three independent source domains, two palette domains
   and three candidates. When that is satisfied, late normal fetches target up to
   two new Portuguese-query/planner sources. Name clarification remains separate.
   Sparse coverage still receives the bounded recovery wave, including donor-brand
   catalogs when necessary. Every discovered candidate remains available for review.
2. **Compact exclusions.** A supported exclusion uses its category string. Full
   objects are reserved for inclusion/uncertainty. Older exclusion objects remain
   accepted defensively. No hue is programmatically excluded by its name; reviewers
   retain source evidence, all three catalog lookups and the independent omission
   audit. Apparent hue-conflict batches can carry 24 independent decisions.
3. **Keep rich batches smaller.** The focused live test showed that twelve rich
   decisions could exceed Qwen's timeout. The final setting is eight candidates
   and 35,000 compact input characters per ordinary batch. Oversized groups split;
   evidence is never truncated. One individually oversized item remains intact.
4. **Remove redundant candidate queueing.** The stable inventory can enter the
   transport batchers together. Their concurrency limits and the account scheduler
   still control actual API calls. An explicit `reviewConcurrency` remains honored.
   This avoids small later batches caused by individual admission slots reopening
   while earlier, richer decisions are still running.
5. **Balance streamed source admission.** Early query results can occupy at most
   half the initial page slots, with a small per-callback allowance. Remaining
   slots are ranked after all initial query results arrive. Search queries and
   the initial page allowance are unchanged. This prevents one fast query from
   filling the allowance with less useful sources before other queries finish.

Main review, final code matching and final verification remain separate. Failed
decisions retain their bounded repair paths and honest incomplete-coverage output.

## Paid validation: exactly two runs

One fresh sequential run each for Corolla and Cruze; no seven-vehicle repetition,
no load benchmark and no paid reruns. These measurements cover changes 1–2 and
the initial twelve-candidate batching experiment. **They precede final changes
3–5 above.** Those corrections were made after inspecting the saved traces and
were tested offline only, to conserve credits.

| Vehicle | Previous time | Focused time | AI | Serper | Total | Model attempts before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Corolla | 137.6 s | 59.3 s | $0.042102 | $0.017 | $0.059102 | 80 → 64 |
| Cruze | 64.3 s | 74.2 s | $0.036818 | $0.026 | $0.062818 | 66 → 61 |

**43 Serper credits; zero search failures/retries. Total estimated cost:
$0.121920 = $0.078920 AI + $0.043 Serper.** Estimates use configured pricing and
returned provider usage; they are not invoice reconciliations.

Both runs passed every quality and cost check, including Branco Lunar/089,
the separate pearl-white/070 identity, and Prata Switchblade. Corolla reviewed
235/235 candidates, compared with 200/236 previously; Cruze reviewed 96/96.
Every output color received final verification and all omission checks completed.
Verification still reported unknown facts, so this is not proof of complete
palette precision or recall. Both runs failed the 40.5-second timing allowance.

The search results varied between runs, so timing changes cannot be attributed
solely to the code. Corolla's discovery ended at 18.6 seconds, versus 38.0 before.
Cruze's discovery ended at 29.3 seconds, with an extraction timeout/fallback.
A twelve-candidate Cruze review then hit Qwen's 14-second timeout and spent
another 11.4 seconds on the OpenAI fallback. Its larger final palette also needed
more verification work. The final payload/queue changes address these measured
causes but have no new live latency measurement.

Reports:

- [Focused results and full palettes](../../tmp/catalog-vehicle-evaluation/suite-1791163972945-e7547d9f/summary.json)
- [Focused runner log](../../tmp/efficient-latency-live.log)
- [Previous seven-vehicle measurements](recovery-validation.md)
- [Final offline regression output](../../tmp/efficient-latency-final-offline.log)

**414 offline tests passed**, with no failures, skips or cancellations (56.9 s).
The regression suite covers independent evidence, sparse-source recovery,
bounded early fetching, all-candidate admission, explicit concurrency overrides,
compact exclusions, uncertain hue inclusion, payload splitting without evidence
loss, all catalog checks, matching, finish filtering and final verification.

## Subsequent target update

The requested default soft target is now **50 seconds**; the live evaluator uses
50.5 seconds including serialization allowance. The discovery stage plan remains
capped at its previous 32-second planning budget rather than expanding with the
response target. Mandatory work is not cancelled at the target; overtime remains
visible in the final timing fields. Historical measurements above retain their
original 40.5-second acceptance threshold.

The updated version passed **416 offline tests**
([log](../../tmp/efficient-50s-offline.log)). This update used no paid API calls;
there is still no fresh live timing measurement of the final queue/payload fixes.

## Subsequent timeout and fallback correction

The saved Cruze trace contained a 14-second Qwen review timeout followed by an
11.4-second GPT fallback. Shorter attempt limits now bound this source of delay:

- Qwen extraction/catalog/verification: 4 seconds instead of 8.
- Qwen candidate reviews: 8 seconds instead of 14.
- GPT attempts: 8 seconds instead of the previous caller-capped 12/16 seconds.
- Qwen capacity admission: 500 ms instead of 2.5 seconds; other routes stay at 200 ms.

Both HTTP requests and response-body consumption are now explicitly bounded,
even with an injected client that ignores cancellation. The HTTP signal is
aborted before fallback, with no parallel speculative request. Failed HTTP status
responses get only 200 ms for their error bodies, and non-JSON authentication or
billing failures preserve their status for cooldown handling. A timeout bypasses
the same model/stage for 3 seconds without disabling other stages; routes recheck
availability after admission to avoid sending into a newly failed provider.
Fallback logs include the phase, attempt limit, elapsed time and timeout code.

Explicit overrides, model order, evidence, cancellation and accounting remain
intact. Sent attempts with unknown billed usage keep their budget reservation;
an unsent attempt skipped after admission is refunded. Aborting cannot guarantee
that a provider stops billing work already performed. Shared capacity waits and
mandatory completion stages can still exceed the 50-second soft target.

**424 offline tests passed**, with no failures, skips or cancellations (55.5 s).
The added tests cover policy limits, stalled requests/bodies, HTTP error bodies,
credential cooldowns, caller cancellation, stage-specific timeout cooldowns and
admission races. [Full regression log](../../tmp/efficient-fallback-offline.log).
No paid model/search calls were made for this correction: **zero Serper credits**.
Live latency, cost and palette accuracy of this version remain unmeasured.
