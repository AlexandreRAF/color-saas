# API-call reduction benchmark

Latest: [Corolla and batching follow-up](#corolla-and-batching-follow-up-2026-10-04).

## Corolla and batching follow-up (2026-10-04)

The changes in this follow-up address evidence association and request overhead:

- Labelled paint cards are parsed locally with their complete names, codes and
  fitment notes. Repeated cards are removed from extraction input; conflicting
  swatch captions remain. Original fetched pages stay available for validation.
- Code hints are bound to their own row/name. Page-opening text no longer cuts
  `070` into `07` or attaches another paint's code. Ordinary prose such as
  “color code to find” no longer contributes `TO` as a code.
- Name clarification uses the existing discovery planner to choose useful leads.
  General archives with incidental mentions no longer displace paint sources.
- Uncertain or invalid batch children share a bounded full-review repair queue.
  Queued reviews wait for a transport slot before their batch is assembled.
  Provider concurrency, fallback order and the $0.06 soft AI target are unchanged.
- Initial code matching overlaps the independent omission audit. Reconsiderations
  cite candidate-owned passages and identify the disputed fact. Unsupported flags
  are logged instead of spawning unsupported repairs. This gate only controls
  rechecking; it does not approve paints or create new candidate exclusions.
- Corolla's 070 assertion uses documented complete identities and an exact OEM
  code, preserving leading zeros and manufacturer boundaries. A code-only label
  still fails. These reference names exist only in test fixtures.
- `--concurrency=2` runs vehicle cases together in one process with the shared
  provider scheduler. It does not duplicate capacity limits across processes.

The offline suite passes **382/382 tests**, including code contamination,
truncation, repeated cards, retained conflicting evidence, candidate-owned omission
citations, batched repairs, queue capacity and concurrent-run isolation. Log:
`tmp/efficient-corolla-speed-tests.log`.

### Intermediate measurements

Before the final batching change, the seven-case suite
`tmp/catalog-vehicle-evaluation/suite-1791155117702-d31b704a/` averaged **52.0 s**
versus the preceding staged suite's **66.7 s**. All seven required references were
found, with main review coverage complete. Gol and Puma passed all checks; five
cases missed timing, and Corolla's omission repair hit its budget. This is not a
production reliability result.

The next two-case parallel pilot,
`tmp/catalog-vehicle-evaluation/suite-1791155643151-bf5dd204/`, included the omission
citation gate but preceded the queued-batch change:

| Vehicle | Time | Model attempts | AI + Serper | Result |
| --- | ---: | ---: | ---: | --- |
| ix35 | 52.0 s | 50 | $0.0380 | Required color/reviews passed; timing failed |
| Corolla | 71.2 s | 93 | $0.0698 | Required colors found; review coverage and timing failed |

Corolla reviewed 301/338 candidates and 25/29 final colors. Its omission gate
rejected 30 unsupported flags, but two supported repairs were blocked by budget.
This pilot does **not** establish reliable parallel operation. It is retained to
make the failures visible rather than reporting only a successful reference.

### Seven-case follow-up with queued batching

`tmp/catalog-vehicle-evaluation/suite-1791155777571-aca329aa/` includes queued
batch assembly and the omission citation gate. It precedes the final local
code-combination guard and preservation of unique swatch-caption qualifiers.

| Vehicle | Time | Model attempts | AI | Serper | Total | Failed checks |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| corolla | 76.902 s | 86 | $0.054575 | $0.021000 | $0.075575 | everyCandidateReviewed, omissionReviewComplete, deadline |
| ix35 | 48.234 s | 45 | $0.018495 | $0.013000 | $0.031495 | deadline |
| azera | 73.325 s | 53 | $0.027616 | $0.013000 | $0.040616 | everyCandidateReviewed, deadline |
| gol | 47.071 s | 31 | $0.016731 | $0.019000 | $0.035731 | deadline |
| puma | 41.014 s | 20 | $0.009271 | $0.012000 | $0.021271 | deadline |
| cruze | 59.652 s | 72 | $0.042234 | $0.019000 | $0.061234 | deadline |
| s10 | 70.836 s | 68 | $0.037755 | $0.023000 | $0.060755 | deadline |

Mean: **59.576 s**, **53.6 model attempts**, **$0.046668**; suite total:
**$0.326677**. Relative to the preceding staged suite, mean time decreased about
11% and model attempts about 11%. This is an observed live comparison, not a
controlled performance guarantee; search content and provider response times vary.

All seven required references were found, and every returned color received final
review. Corolla reviewed only **228/366** candidates and its four omission repairs
were budget-blocked. Azera reviewed **107/108**; the remaining decision cited
finish evidence without the candidate's name. No case passed the 40.5-second check.
Partial fact confirmation persists even where review coverage is complete.

Final output inspection also found BASF descriptions such as `YFB + YAC` in
Corolla's palette. Their component codes already have separately named records
in the same manufacturer/model catalog. A subsequent deterministic guard now
recognizes these combinations using the safe standard-code column, leaving
component paints eligible and the raw catalog records intact. Alphabetic words
are not treated as codes without catalog proof; `Ice + Ink` remains a possible
name. This adds no AI calls. Its focused live follow-up is recorded below.

### Final artifact check with two simultaneous vehicles

`tmp/catalog-vehicle-evaluation/suite-1791156506939-5e48783d/` includes all final
runtime changes, including catalog-backed combination detection and retained
swatch qualifiers. Both cases ran together with `--concurrency=2`.

| Vehicle | Time | Model attempts | AI | Serper | Total | Main reviews | Final reviews |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corolla | 59.162 s | 81 | $0.048891 | $0.015000 | $0.063891 | 242/242 | 26/26 |
| ix35 | 54.129 s | 50 | $0.024604 | $0.015000 | $0.039604 | 113/113 | 20/20 |

Both passed every reference, catalog, review-coverage, omission-repair, finish and
cost assertion. Both failed timing; **0/2 passed the complete benchmark**. The
Corolla result contains **Branco Lunar / 089** and **Blizzard Pearl / 070**. ix35
contains its required Shimmering Silver. Neither result contains the bare code
combination labels. Every omitted candidate was audited (Corolla 214/214, ix35
94/94), with no failed omission repairs. Thirty-seven unsupported Corolla flags
and four ix35 flags were rejected and logged by the evidence/issue guard.

Facts can still remain uncertain despite complete review coverage. These two
runs do not establish seven-way scalability, full palette precision or stable
40-second latency. The other five cases were tested before the final local
combination/qualifier fixes; they were not rerun afterward. The earlier failures
remain above and in their unmodified artifacts.

The original backend's **114 files** still match the pre-copy SHA256 manifest.
Only `backend_serper_qwen_efficient` contains implementation/documentation edits.

## Staged-flow evaluation (2026-10-04)

The lifecycle now collects a stable inventory before reviewing, matching and
independently auditing it. Explicit rows are parsed locally; unparsed content
uses batched extraction. Discovery has one optional planning expansion and one
clarification wave. Successful extraction is not audited again. A separate
omission audit can send flagged decisions through one main-review repair wave.
Successful matches are reused, while failed matching gets one retry. The final
verifier still searches and reviews every output color, reusing existing
independent page evidence where possible. All three catalogs remain mandatory.

No required paint names were added to production searches. Generic specialist
palette queries, first-page admission for paginated results, and source/query
diversity recovered previously missed references. The model routes and $0.06
soft AI budget were retained. These changes simplify control flow but have **not
demonstrated the requested latency improvement**.

The seven-case suite is
`tmp/catalog-vehicle-evaluation/suite-1791152589628-acb7f819/`.

| Vehicle | Time | Model HTTP attempts | AI | Serper | Total | Failed checks |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| ix35 | 71.134 s | 63 | $0.030438 | $0.015000 | $0.045438 | deadline |
| Azera | 56.712 s | 63 | $0.030933 | $0.017000 | $0.047933 | deadline |
| Corolla | 94.222 s | 103 | $0.051501 | $0.025000 | $0.076501 | 070 reference, candidate coverage, deadline |
| Gol | 52.805 s | 44 | $0.023507 | $0.022000 | $0.045507 | deadline |
| Puma | 47.464 s | 24 | $0.011692 | $0.011000 | $0.022692 | deadline |
| Cruze | 85.872 s | 81 | $0.048111 | $0.021000 | $0.069111 | deadline |
| S10 | 59.019 s | 45 | $0.024336 | $0.017000 | $0.041336 | deadline |

Mean **66.747 seconds**, **60.4 model attempts**, **$0.049788**; total **$0.348518**.
All seven stayed below the cost ceiling. Six passed the minimum reference and
review checks. **0/7 passed the complete benchmark.** Corolla reviewed 172/325
candidates; all output colors received final review, with some facts unresolved.
Compared with the previous seven-case evaluation, cost decreased and elapsed
time increased. Different live search results and provider behavior prevent
attributing those differences to any single change.

### Follow-up fixes and limits

Final offline regression suite: **365 passed, zero failed**, including catalog
refresh, finish-bearing complete names, bounded matching retries and auditing
names withheld by the output guard. Log: `tmp/efficient-staged-tests.log`.
All 114 original-backend files still match the pre-copy SHA256 manifest.

After this suite, the code gained original-source validation for compacted
extraction quotations, refreshed catalog lookups when later sources add codes,
and a name-completeness correction. A reviewed full name with a finish suffix
and one published code can survive a longer translated name; bare ambiguous
fragments still remain unresolved. Source diversity no longer nearly erases the
original relevance ranking.

The Corolla follow-up is
`tmp/catalog-vehicle-evaluation/suite-1791153192740-1c333c6f/`:
**83.7 seconds, 101 model attempts, approximately $0.0727 including Serper**.
It returned **Branco Lunar / 089** and **Blizzard Pearl / 070**. The saved evaluator
still marked 070 missing because it required “white” or “branco” in the name.
The evaluator now accepts the published Blizzard Pearl identity with 070 and
continues rejecting code-only labels. Saved historical results were not rewritten.
This correction does not turn that run into a pass: only 141/279 candidate reviews
completed, four omission repairs failed, and timing exceeded the target.

The final omission audit also receives names withheld by the output completeness
guard, even if the earlier agent marked them complete. That small final change
was regression-tested, not included in the live suites above. The seven cases have
not all been rerun after the follow-up fixes.

Remaining bottlenecks are broad all-year inventories, extraction/provider
timeouts, conservative budget charges for timed-out calls, and the sequential
review/matching/omission-repair/verification path. Broad inventories can still
consume the budget before every candidate is reviewed. Reported costs exclude
unknown provider usage on failed calls; they are not billing guarantees. This
copy should remain experimental rather than replace the original backend.

Earlier staged tuning runs are retained in suites
`suite-1791149229864-b4e20d05` and `suite-1791152142019-6b025964`; neither established
the performance or reliability target. Current architecture and commands are in
the [README](../README.md).

This backend is an independent copy of `backend_serper_qwen_models`.
The source backend was checked against its pre-copy SHA256 manifest and was not
modified. This experiment targets **$0.07–$0.08 total per vehicle** and a
**40-second average**. It does not establish a production latency guarantee.

## Changes

- Small page segments share extraction requests; the full source text remains
  available across segments. Dense paint tables use bounded units and overlap.
- A conservative name-clarification check skips AI only when the fetched text has
  no usable searched-name fragment or supplied paint code. General research and
  uncertain/short fragments keep their normal extraction. Long clarification
  documents send only segments with those fragments or codes. The full fetched
  text remains available for review and the page is still reported. This avoids
  analyzing unrelated sections of manuals during targeted name clarification.
- With a requested hue, extraction returns that family, mixed target shades and
  uncertain visual colors. Commercial names alone cannot establish a visual
  mismatch; literal row recovery and local model records retain all named leads.
  Silver and gray share one comparison family. Other hue decisions need the
  candidate's own descriptions or explicit categories. The extractor reads the
  complete source and does not filter finishes.
  Unrestricted searches still extract the complete potentially relevant palette.
- Every candidate still queries Lazzumix, BASF and BASF models. Catalog identity
  selection shares the main candidate review, removing a separate identity call.
  Equivalent catalog editions retain all their original years in compact rows.
- Main reviews share transport batches and source passages, with separate
  decisions and citation validation. Apparent hue conflicts receive compact
  exclusion checks; uncertain cases receive a full review.
- Review objects use a consistent name-status field. Explicit exclusion objects
  are normalized to their equivalent category verdict.
- A malformed child response is repaired independently. Valid siblings are
  retained. Other structured requests remain strictly validated.
- The separate final code matcher rechecks local identities. The separate final
  verifier searches every returned name in groups of six, adds individual searches
  when identity evidence is missing, and reviews groups of four colors.
- Verification cites numbered source units. Code restores the exact quotations,
  avoiding long generated quotations and rejecting invalid references.
- HTML parsing uses parse5 directly. Five local parity fixtures, including a
  3,000-row table, matched the previous extractor. On that synthetic table the
  measured parse times were 301 ms with jsdom and 59 ms with parse5; this is a
  local CPU comparison, not an end-to-end latency result.
- Unsent model requests release capacity and cost reservations. Final output now
  includes actual model HTTP attempts in `modelRequests`, including fallbacks.

The default research allowance is ten main searches, six name-clarification
searches and 24 main pages, followed by final verification. Late replacement
fetches target at least 20 readable main pages. `maxSearches: 14` and
`maxPageFetches: 35` restore the source backend's larger main allowances.
The staged lifecycle does not schedule successful-page full audits; the standalone
page analyzer retains its legacy audit option for compatibility. Literal code/name rows and explicit color-name/year lists provide a deterministic
recovery path with verbatim evidence and normal agent review. No cross-run result cache was added.

## How this was measured

Seven Brazilian vehicle cases run sequentially using real Serper and model APIs.
The runner checks reference colors/codes, mandatory catalog coverage, completed
candidate reviews, final review of every output color, finish constraints, cost,
and a strict 40.5-second per-case threshold. That threshold is stricter than the
requested 40-second average. Reference checks do not prove exhaustive precision
or recall; uncertain candidates and unresolved facts remain visible.

Costs are estimated AI usage plus Serper at the configured $1/1,000 credits.
They exclude hosting, taxes, credit-purchase fees and unreported usage from
timed-out model requests. Actual account billing remains authoritative.
`modelRequests` counts HTTP attempts; per-model billed-call counts can differ
when providers do not return usage for a failed attempt.

The Corolla reference was corrected from Branco Lunar/070 to Branco Lunar/089.
The local Lazzumix records and Toyota's [published color list](https://media.toyota.com.br/8e0f7a8d-03e9-4eab-8bfe-80ef8097c4bb.pdf)
identify Branco Lunar as 089. A separate check still requires a pearl-white 070
candidate. The current Toyota document does not by itself establish exact 2018
availability.

## Original backend diagnostic

Only two original-backend baseline cases were run. Both failed with
`Capacity wait exceeded 120000 ms` and returned no colors:

| Vehicle | Time | Model HTTP attempts | AI | Serper | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| ix35 | 154.7 s | 192 | $0.044020 | $0.020000 | $0.064020 |
| Azera | 155.6 s | 195 | $0.047214 | $0.020000 | $0.067214 |

These are failure diagnostics, not a successful seven-case performance baseline.
Their artifacts are in
`tmp/catalog-vehicle-evaluation/suite-1791131924860-d460a30e/` at the repository root.

## Earlier funded evaluation

Before the general visual-color correction, suite
`tmp/catalog-vehicle-evaluation/suite-1791144485961-41033928/` completed all seven
cases with no failed Serper uses. It averaged **45.68 seconds**, **73.3 model HTTP
attempts** and **$0.061932 per vehicle** ($0.433522 total).

Only Azera passed every acceptance check. Corolla, Cruze and S10 left research
candidates unreviewed after budget admission failures. Cruze and S10 exceeded
$0.08. Gol retained Platinum Gray/LD7X but wrongly excluded its documented
Portuguese candidate as a different hue. A stronger silver/gray prompt alone
did not fix a subsequent Gol run. This led to removing the remaining automatic
name-word filters and correcting the per-request review instructions and all
agent stages to distinguish commercial names from visual-color evidence.

These failures are retained in the report; reference-name presence alone is not
a passing quality result. The earlier suite is not the benchmark for the final
visual-color changes.

## Evaluation after the visual-color changes

The seven-case suite `tmp/catalog-vehicle-evaluation/suite-1791145067496-7701b819/`
used the general commercial-name/visual-color rule and retained named model
records regardless of hue words. It preceded the later explicit name/year-list
recovery fix, which receives a separate Gol follow-up below.

**The copy does not yet meet the requested reliability and 40-second average.**
Only Azera passed every acceptance check. All output colors received a final
review, but that does not mean every field was confirmed. Reference colors were
found for six cases; Gol returned Platinum Gray/LD7X but lacked the required
Portuguese name. The reference failure is retained rather than weakening the test.

| Vehicle | Time | Model attempts | AI | Serper | Total | Unreviewed research candidates | Failed checks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ix35 | 53.28 s | 72 | $0.039989 | $0.021000 | $0.060989 | 0 | deadline |
| azera | 39.61 s | 76 | $0.045186 | $0.020000 | $0.065186 | 0 | None |
| corolla | 56.00 s | 70 | $0.048851 | $0.025000 | $0.073851 | 137 | everyCandidateReviewed, deadline |
| gol | 33.37 s | 40 | $0.024044 | $0.026000 | $0.050044 | 0 | referenceFound |
| puma | 45.23 s | 59 | $0.035110 | $0.019000 | $0.054110 | 0 | deadline |
| cruze | 54.32 s | 92 | $0.058014 | $0.025000 | $0.083014 | 49 | everyCandidateReviewed, deadline, cost |
| s10 | 50.97 s | 96 | $0.056595 | $0.026000 | $0.082595 | 74 | everyCandidateReviewed, deadline, cost |

Mean: **47.54 s**, **72.1 model attempts**, **$0.067113 per request**. Suite total: **$0.469789**.

All Serper uses succeeded in this suite. Main remaining problems:

- Long documents, name clarification and provider timeouts still delay the
  extraction-to-review handoff. Final verification adds further elapsed time.
- Broad palettes can spend the research allowance before every candidate is
  reviewed. Retaining uncertain visual colors increases that workload; dropping
  them by name would violate the intended comparison-palette behavior.
- Cruze and S10 finished slightly above the $0.08 combined target despite the
  AI-only estimate staying below $0.06.
- Extraction can still miss explicitly printed names. The follow-up adds literal
  name/year-list recovery with source quotations, without extra extraction calls.
- Reference checks are not an exhaustive precision audit. The Corolla result
  still contained code-combination labels such as `3Cb + Yac`; the Gol follow-up
  retained both Platinum Gray and Cinza Platinum. Those identity/formatting
  issues also prevent treating this experiment as a production-ready replacement.

The original two-case diagnostic used 192/195 model attempts; these ix35/Azera
runs used 72/76. That is fewer attempts, but the original runs failed and this is
not proof of equal recall, a successful baseline speedup, or scalability.
No simultaneous multi-request production-load guarantee is established.

## Gol follow-up after literal list recovery

`tmp/catalog-vehicle-evaluation/suite-1791145425606-c40ea64d/` passed every
acceptance check: **38.51 seconds**, **45 model HTTP attempts**,
**$0.025293 AI + $0.026000 Serper = $0.051293 total**.
The final result included **Cinza Platinum / LD7X**, with all research candidates
reviewed and all 19 output colors reviewed by the final verifier.
Some individual facts still remained unresolved. This is one focused follow-up,
not a replacement for the seven-case results above. The final list-recovery
change has not been retested across all seven vehicles.

## Reproduce

Final offline regression run: **341 tests passed, zero failed**. Log:
`tmp/efficient-offline-tests.log`. The original backend's 114 tracked manifest
entries still matched their saved SHA256 values after all changes.

From the repository root:

```bash
node --test --test-concurrency=1 backend_serper_qwen_efficient/tests/*.test.js
node backend_serper_qwen_efficient/evaluate_vehicles.js
```

The second command makes paid calls. Reports include final colors, source URLs,
per-model usage, costs, warnings and event logs. See the [README](../README.md)
for architecture, configuration and artifact locations.


## Review-completion evaluation (2026-10-04)

This follow-up fixes budget-driven skipped candidate reviews. The shared budget
protects reviews while extraction and code matching overlap, then reforecasts
final-verification funds after the first review wave. Every unresolved candidate
counts as a possible final color; only settled exclusions reduce that forecast.
The configured $0.06 soft AI target was not increased.

The planner no longer receives repeated full catalog/evidence payloads. Candidate
review batches share verbatim source passages and a catalog table, with separate
allowed references and validation for every candidate. Equivalent catalog years
remain available. Batch sizing uses the compact payload size. Failed decisions
receive one bounded retry wave; successful siblings are retained. Review request
timeouts allow Qwen 14 seconds and GPT routes 16 seconds. The final matcher uses
the standard GPT-6-Luna tier. Provider/model fallback order is unchanged.

Public `research.reviewCoverage` exposes total, reviewed and unreviewed counts.
The evaluator rejects incomplete or inconsistent counts. Persistent failures
remain visible; retrying does not mark unsuccessful work as reviewed.

**351/351 offline tests passed**, including reservation accounting, scoped catalog
references, independent repairs, retry behavior, cancellation, and coverage
reporting. A SHA256 comparison found no changes to the 114 source-backend files
in the pre-copy manifest.

The final implementation was evaluated sequentially across two live suites:

- `tmp/catalog-vehicle-evaluation/suite-1791147832275-3880ded3/`: Corolla, Cruze, S10.
- `tmp/catalog-vehicle-evaluation/suite-1791148023091-67b27548/`: ix35, Azera, Gol, Puma.

| Vehicle | Candidate reviews | Final reviews | Time | AI | Serper | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ix35 | 100/100 | 16/16 | 41.342 s | $0.032508 | $0.017000 | $0.049508 |
| Azera | 119/119 | 11/11 | 56.052 s | $0.029876 | $0.020000 | $0.049876 |
| Corolla | 243/243 | 16/16 | 55.918 s | $0.048307 | $0.027000 | $0.075307 |
| Gol | 71/71 | 20/20 | 48.124 s | $0.026545 | $0.020000 | $0.046545 |
| Puma | 66/66 | 5/5 | 40.906 s | $0.018863 | $0.015000 | $0.033863 |
| Cruze | 114/114 | 48/48 | 52.722 s | $0.047149 | $0.024000 | $0.071149 |
| S10 | 160/160 | 86/86 | 60.340 s | $0.055922 | $0.034000 | $0.089922 |

All seven passed both review-coverage checks: **873/873 research candidates and
202/202 final colors**, with all three mandatory catalog lookups completed.
Costs total **$0.416170**, averaging **$0.059453 per vehicle**. Average latency was
**50.772 seconds**. Cost reporting has the billing limitations described above.

**0/7 passed the full benchmark.** Every case exceeded its 40.5-second assertion.
S10 exceeded $0.08. ix35 did not discover Shimmering Silver; Azera did not discover
Ice White. Corolla retained Branco Lunar but returned no code for it, failing
the required 089 identity check after matcher budget failures. Its separate 070
check passed. Gol, Puma, Cruze and S10 found their required references.

The final verifier reviewed every color, but some facts remain unknown or have
insufficient citations; its fact-confirmation status remains partial. Completed
reviews do not mean all facts are confirmed or every possible paint was found.
The original reliability, precision and 40-second average goals therefore remain
unmet. This evaluation establishes the review-coverage improvement on these seven
runs, not a production reliability guarantee. Earlier tuning failures remain in
the saved suite artifacts and are not represented as passing runs here.
