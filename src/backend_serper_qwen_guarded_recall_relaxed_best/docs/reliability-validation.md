# Reliability validation

Historical validation before the production-hardening pass. For the current
revision, see [production hardening and release gates](production-hardening.md).

These changes apply only to `backend_serper_qwen_efficient`. The source backend,
root environment and catalog database files were not changed by this work.

## What changed

- Route attempts reserve fallback time while waiting for first content. Productive
  streams may continue within their original attempt/stage limit. Almost-expired
  stages do not start new paid attempts or mark a healthy provider unavailable.
- Complete, schema-valid streamed children survive interrupted or length-limited
  responses. Fully invalid responses continue to a fallback. An omitted outer
  wrapper is restored only for a valid, unambiguous single-candidate response.
- Batch evidence IDs are globally unambiguous and translated back to each
  candidate's original IDs. Sibling evidence cannot be borrowed accidentally.
- Catalog selections return representative manufacturer/code/finish rows instead
  of every formula edition. Every original row remains available to the matcher.
- Hue checks start as individual approvals settle. Unknown marketing hues use a
  compact evidence check; uncertainty always requires a full review. Names alone
  never establish exclusion. Silver and gray remain comparison neighbors.
- Stable approved decisions start the separate matcher while other reviews
  finish. Omission audits run in bounded batches, join before final verification,
  preserve successful siblings and retain their protected budget until settled.
- Lazzumix `(B)`/`(E)` formula-layer annotations no longer prevent an otherwise
  exact name match. Bare version letters, Roman numerals and BASF names retain
  their existing meaning. This enabled the local Branco Lunar / 089 match.
- Candidate repairs share one ledger. A genuine stall skips the stalled route;
  a malformed child can receive one focused correction without regenerating its
  valid siblings. All coverage and missing-cost diagnostics remain explicit.

The main reviewer, matcher and final verifier remain separate. The 50-second
deadline, 20-search-attempt ceiling including retries, source evidence rules,
three mandatory catalogs and AI budget accounting remain enforced.

## Final offline checks

**476/476 tests passed**, including routing/stream interruption, schema validation,
candidate-local evidence, catalog identities, bounded repairs, omission overlap,
API capacity, cost tracking, search limits and output handling.

Log: `tmp/efficient-reliability-final-regressions-v3.log`.

This is regression evidence, not proof of live palette completeness or reliability
under production concurrency. No seven-vehicle or load suite was rerun in this pass.

## Live Corolla attempts

All attempts from this work are listed below; intermediate versions differed.
Costs are known AI plus estimated Serper subtotals. Each run had missing model
usage, so none has a complete billable-cost estimate. The reported subtotal must
not be treated as the full cost or a passed cost check.

| Run | Processing time | Search attempts / failed | Candidate reviews | Omission checks | Final-color reviews | Required references | Known subtotal | Missing usage calls |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 48.0 s | 11 / 3 | 216/217 | 120/203 | 0/9 | Pass | $0.038748 | 23 |
| 2 | 47.2 s | 11 / 4 | 298/307 | 96/281 | 13/13 | Fail: 089 code missing | $0.046282 | 13 |
| 3 | 48.0 s | 13 / 6 | 298/315 | 120/277 | 15/17 | Pass | $0.052548 | 11 |
| 4 | 47.9 s | 13 / 0 | 291/311 | 235/267 | 20/20 | Pass | $0.055640 | 4 |
| 5, final code | 48.0 s | 12 / 0 | 216/217 | 206/206 | 10/11 | Pass | $0.043556 | 3 |

**All five failed overall acceptance.** The final run fetched 30 pages, returned
11 colors and retained Branco Lunar / 089 and a separate 070 pearl-white paint.
`Super White` remained unreviewed. One final color remained unverified; unresolved
facts remained for other reviewed colors as well. Three omission repairs recovered
candidates. The response correctly reports partial research and verification.

These runs used **60 Serper attempts total**, including failures. Model-only
replays below used no Serper. Existing cost estimates exclude hosting and any
unreported provider charges.

Reports under `tmp/catalog-vehicle-evaluation/`, in table order:

1. `suite-1791212826073-397e2562/summary.json`
2. `suite-1791213307166-6f6b0007/summary.json`
3. `suite-1791214009090-763d7796/summary.json`
4. `suite-1791214470566-fbf3241a/summary.json`
5. `suite-1791216655189-14d52f58/summary.json`

## Model-only saved-evidence checks

Saved pages isolate review behavior without paying for repeat searches. Local
catalog preparation is measured separately; the evaluator assumes discovery has
already consumed part of the 50-second budget. These checks do not include
matching, omission audits, final verification or fresh-search variability.

| Experiment | Candidate reviews | Review time | Model calls | Review-only known cost | Missing usage |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bounded catalog selections | 307/307 | 11.8 s | 27 | $0.023975 | 0 |
| Remove schema from Qwen text prompt (reverted) | 298/315 | 15.0 s | 34 | $0.029480 | 0 |
| Final evidence-triage implementation | 315/315 | 16.1 s | 21 | $0.023288 | 0 |

The final replay recovered all 19 candidates requiring the bounded full-review
repair and retained the required white names. It assumed 17 seconds already spent
on discovery. Its complete cost applies only to these 21 model calls.

Artifacts: `tmp/efficient-corolla-bounded-catalog-replay.json`,
`tmp/efficient-corolla-single-schema-replay.json`, and
`tmp/efficient-corolla-final-triage-replay.json`.

Earlier diagnostics in this pass were also incomplete: the initial replay reviewed
300/315, the subsequent timing correction reviewed 314/315, and another inventory
reviewed 306/307. Their artifacts are `tmp/efficient-corolla-reliability-replay.json`,
`tmp/efficient-corolla-reliability-fixed-replay.json`, and
`tmp/efficient-corolla-reliability-complete-replay.json`.

## Remaining release blockers

- Complete candidate and final-review coverage is still sensitive to model latency
  and fresh-source variability. The last live run still failed both checks.
- A completed review is distinct from confirmation of every identity, code,
  applicability and finish fact. The final run confirmed no color in all fields.
- Timed-out providers can omit usage; total charges remain unknown in those cases.
- Current behavior has not passed all vehicle cases or concurrent load validation.

Do not promote this backend as mission-critical production-ready on the basis of
the passing offline suite, the successful saved review replay, or minimum required
color references. The live acceptance failures remain visible and unresolved.
