# Backend maintenance standards

These instructions apply to this directory and its descendants. Follow ancestor
instructions as well. Read [README.md](README.md) for the current architecture,
module map, configuration and commands before making changes.

## Organization

- Keep `ai.js` focused on the run lifecycle: shared state, stage ordering,
  deadlines, overlapping queues and cleanup.
- Keep vehicle-type search vocabulary in `vehicle_profiles.js`. Unknown vehicle
  types remain valid and use general terms; never make a type profile a paint
  eligibility rule. Keep model/year-specific generic display-label admission in
  `display_color.js`, with its identity type visible in output. Do not promote
  a broad hue word or seller filter to a unique paint identity.
- Keep fleet-standard claim crossing in `source_claim_scope.js`: one fetched
  source must explicitly name the paint as standard across the maker's fleet,
  and a different fetched domain must identify the requested model and period.
  Preserve both claim scopes for the main reviewer and keep model-context
  passages out of paint-code extraction. Never treat a brand palette or photo
  as a model paint by itself. Specialist discovery coverage can use two
  corroborating fetched web domains after recovery, not two catalog editions.
- After main review, matching and formatting, keep all reviewed comparison leads in `colors`
  and annotate each `applicabilityScope` in `palette_scope.js`. An exact model
  page, exact BASF model row, qualified display label or explicit crossed fleet
  claim can establish a model candidate. Brand-wide paint pages alone remain
  `manufacturer_only`; do not imply model/year fitment from them. Report a
  partial completion if every color has only maker-wide evidence. Keep linked
  thumbnails for other product pages and retail coating titles out of the
  candidate identity inventory without suppressing a separately printed color.
- `manufacturer_paint_recovery.js` runs only after ordinary discovery found no
  model-linked named candidate. It may extract a complete manufacturer-qualified shade from
  a paint product title as a visibly scoped comparison lead. Do not promote
  the full coating title, package size or seller SKU into a paint name or code.
  Reuse indexed results before spending its bounded search/fetch allowance;
  all recovered leads still receive the normal main review and code checks.
- `shared_paint_research.js` may search a donor maker only when a fetched page
  explicitly says the requested maker used that donor's paints. Limit it to the
  requested period and existing browser/page budgets. Keep both the sharing
  claim and donor shade source, and label the result `shared_paint_possible`.
  The claim is context, not proof of this paint's code or exact model fitment.
  Proprietary and donor paints may coexist; a shared chassis is insufficient.
  Without a predominant color, search the donor's full period palette and
  keep the bounded set of supported exterior paints across hue families.
- `empty_palette_fallback.js` may supply one run-observed paint only after the
  normal reviewed, matched and formatted palette is empty and candidate/omission
  review coverage is complete. Keep that exception
  visibly marked as a fallback with its earlier exclusion reason and partial
  completion. Never invent a name or code to
  cover failed research or an inventory with no named paint.
- `observed_color_fallback.js` is a separate last resort after named-paint
  fallback. It can show one generic hue from an explicit color field on a
  fetched page for the requested model, with appearance-only scope, empty code
  and any different source year visible. Never present it as a paint formula
  or factory availability, and do not use an input hue without source evidence.
- Finish-qualified generic display labels still query all three catalogs by
  exact name, but cannot acquire a code from those rows or a fuzzy final match.
- Keep web-only OEM code crossing in `web_code_evidence.js`, after all mandatory
  catalog lookups and inside the separate matcher. Require paint-owned passages
  from two fetched domains; search snippets and one-source codes stay unknown.
- Keep the main research agent and final code matcher separate. The former
  final color verifier is optional and off by default; the omission audit remains active.
  Put detailed work in focused modules with explicit inputs and dependencies.
- Keep staged orchestration in `discovery_pipeline.js` and `review_stage.js`.
  `settled_review_work.js` buffers completed stable-inventory decisions for the
  separate matcher and omission verifier while other reviews finish. Never send
  a provisional decision or a still-changing discovery candidate to this queue.
  Join every audit before final formatting, aggregate coverage once per ID,
  retain sibling results on failure, and release omission funds only at that join.
  `omission_review.js` owns the independent omission audit and its one repair
  wave. Do not reintroduce speculative review/matching during collection or
  recursive discovery/review loops. Genuine no-match and failed matching are
  distinct outcomes; successful sibling decisions must not be repeated.
- `verification_research.js` is used only when the optional final review is
  explicitly enabled. Keep the normal omission audit independent of that option.
  Optional final decisions must check the current color and its own evidence.
- `completion_review.js` owns the single final attempt for unfinished reviews
  and the programmatic palette coverage check. Preserve confirmed finish
  exclusions and report unresolved identities; never manufacture a missing code.
- Do not stack automatic batch repair, stage retry and completion repair. Keep
  one bounded first-pass correction ledger, retain validated siblings, and skip
  budget retries when no additional funds can admit the work. A separately
  supported omission dispute may receive one audit correction even after a
  format/transport correction. Keep its own per-run ledger, pass the disputed
  candidate-owned passages, reopen all catalog choices and never re-audit or
  recursively retry that correction. Start the repair queue as failed
  children arrive; do not wait for the slowest independent first-pass batch.
  The independent audit still reports its coverage.
- `review_groups.js` may share a decision for aliases with
  identical maker, code, model/year scope and known finish. Web aliases additionally
  need the same web evidence and a verbatim passage naming both full identities
  and the code. Code alone never proves an alias. Every original
  candidate must still query all catalogs and retain its own source IDs.
- Keep code matching scoped to each color's complete name and owned source
  passages. A code may legitimately belong to more than one named color;
  never enforce code uniqueness across the palette or merge names by code
  alone. A short shared component of a compound catalog code does not prove
  the remaining components. Compare every source-printed long OEM code before
  attaching a catalog row. A documented finish suffix and a definitively
  contradictory catalog finish cannot identify the same paint. Retain an
  otherwise supported color with an unknown code when identity remains
  uncertain.
- `pipelineDeadlines()` sets fixed wall-clock cutoffs within a soft 60-second
  target and hard 100-second maximum. Capacity waiting and fallback attempts
  consume the same stage budget. Preserve finished work and report incomplete
  coverage on expiry; never count timeouts as exclusions or completed reviews.
- Filter documented manufacturer/code labels before splitting inventory names
  and again after matching. Keep named component paints and record removed
  identifiers in `research.identityArtifacts`. Numbered marketing names and
  unproved identifiers must not be discarded by shape alone. Do not split commas
  or slashes inside parenthesized catalog annotations into new paint names.
- Discovery recovery is one bounded wave inside the existing search quota.
  Keep the Portuguese-name query reserved, wait for outstanding searches before
  judging coverage, and never hardcode expected vehicle-test paints.
  Replacement fetching repairs inadequate independent paint evidence, not a
  successful-page quota. Adequate coverage still gets targeted Portuguese-name
  sources and mandatory name clarification. Keep the initial broad searches.
  Bound early streamed admissions so the first query cannot occupy every page
  slot before the other seed queries return.
- Treat HTTP error text inside a reader's successful HTTP response as a failed
  source fetch. A structured, vehicle-specific search snippet may preserve a
  bounded low-confidence name lead when its page fails, but it never proves a
  code, finish, year or successful page fetch. Keep it in normal review and
  optional final verification; do not hardcode expected vehicle-test paint names.
  This copy also admits a structured model palette indexed one year from the
  requested year as an adjacent-year name lead. Do not admit an isolated paint
  title on that basis. Keep snippet-only confidence low, mark its public scope
  `adjacent_year_lead` unless stronger model evidence arrives, and reject all
  final fact confirmations based solely on an unread search snippet.
- Compact review exclusions are category strings; full objects are inclusions.
  Apparent hue conflicts and names without a recognized hue word may use an evidence-based compact check that returns
  an exclusion or `review`. Every uncertain check must enter a full first-pass
  review under the original review deadline. Triage is routing, not a failed
  review, and must not consume the first-pass correction allowance; no commercial
  name alone proves exclusion.
  An absent hue word proves nothing either. Keep silver/gray comparison neighbors
  together; unrestricted-hue requests still receive full review.
  Preserve uncertain hue/finish candidates and each candidate's evidence/schema
  checks. Larger transport batches must not merge unrelated paint identities.
  A candidate in the requested named hue must not be excluded as
  `unrelated_hue` for model/year uncertainty alone. Retain it with low
  confidence and uncertain applicability unless an actual visual conflict or
  explicit exclusive year range supports exclusion.
  Transport queues and the shared scheduler bound paid calls. Do not add a
  second default candidate-admission gate that fragments or starves batches;
  preserve an explicit caller-provided admission limit.
- Review transport uses globally unambiguous evidence IDs with candidate-local
  allowlists, restoring the original IDs before source validation. Never repair
  an invalid citation by selecting the nearest ID or another candidate's passage.
  A missing outer R wrapper may be restored only for one request whose complete
  child already matches the schema. Multiple candidates remain strictly keyed.
  Interrupted output may suppress a whole-batch fallback only when it contains
  schema-valid children; fully invalid output must try the next route. Keep Qwen's
  explicit prompt schema: removing it regressed the paid saved-evidence benchmark.
- Run hue checks as approved candidates become ready; do not put them behind a
  barrier waiting for all unrelated first-pass reviews. A failed hue check keeps
  its main decision for targeted retry, without counting it as a completed review.
- Reserve fallback time while awaiting first content, but allow productive
  streams to continue within their original stage and attempt deadlines. Never
  send new paid attempts with less than the minimum usable window. A shortened
  stage window is not a provider-health failure and must not disable later work.
  The default minimum is 1.5 seconds. Reserve fallback time only when that
  fallback could itself meet the minimum; do not create subsecond retry bursts.
  Skip stalled routes on repair; malformed individual decisions may use one
  focused correction on the normal route. Keep all repair attempts in one ledger.
- Keep account admission in `model_scheduler.js` and its Unix-socket coordinator
  (`capacity_server.js`, `capacity_client.js`). Never send credentials, prompts or
  source documents through this protocol. A configured coordinator must fail
  explicitly instead of silently restoring independent per-worker quotas.
- Size model batches with `request_envelope.js`, including provider schemas and
  output allowance. Never shorten an indivisible candidate's evidence to fit.
  Main-review timeout recovery keeps validated siblings and sends unfinished
  decisions to the completion queue. Verification recovery may split unfinished
  work once and continue at the next route. Keep verification splitting
  in `verification_request.js` and streaming transport in `model_stream.js`.
- Streaming keepalives, role-only events and whitespace are not generation
  progress. Retain first-content, idle and absolute limits plus caller aborts.
  Record every sent attempt once, including missing usage; incomplete cost
  estimates stay null while the known subtotal remains available.
- Preserve the scheduler's combined model ceiling and completion headroom across
  workers. Omission audits have their own protected budget and release unused
  funds when settled; do not charge their work to ordinary review allowances.
  Count ordinary active jobs separately: completion work already occupies its
  slots and must not consume the ordinary reserve a second time. Production run
  admission uses the same coordinator before paid work; reject overload with a
  retryable error and release its ticket only after cleanup. A rejected vehicle
  is not a successful concurrent benchmark run.
- Keep extraction-section reuse run-local and evidence-preserving. Changed
  vehicle context, years, finishes or restrictions must prevent reuse; restore
  citations against the receiving page. Do not introduce persistent search/result
  caching into load benchmarks.
- Keep downloads in the run-local `page_pool.js`, shared by discovery,
  clarification and verification. Store promises before starting work. Prefetch
  only ranked relevant sources within its buffer/total/concurrency limits; it
  must not create candidates or model calls without explicit source selection.
  Preserve requested-page priority, shared network admission, cancellation,
  five-second attempt limits and bounded transient retries. Report real attempts
  separately from reuse, including unused downloads, without double-counting
  evidence pages as additional fetches. Never make this a persistent cache.
- Keep initial broad/specialist searches independent. Group only explicit
  related follow-ups, with query slots reserved for individual fallbacks. Track
  coverage for each paint/question using its own fetched/extracted evidence;
  a successful OR result does not cover every branch. Grouping is transport
  only, not alias, finish or donor-brand proof. Multiple name leads must remain
  separate in extraction context, cache keys, recovery and page replays.
  Every final color still receives model verification even when existing
  independent pages make a new search unnecessary.
- Enforce `search_budget.js` for every search provider and stage. The hard
  maximum is 20 logical uses AND 20 search HTTP attempts per vehicle, including
  retries. Reserve atomically before sending and before Serper cost tracking.
  Keep four default slots for verification. Do not bypass this through new
  fallback/search paths or count denied work as provider failures. Verification
  has six primary queries, two individual identity fallbacks and twelve new page
  admissions. Unknown finish alone must not trigger extra searches. Exhaustion
  retains mandatory model reviews and unresolved facts using existing evidence.
- Preserve the existing boundaries: `research_model.js` handles structured
  requests, `candidate_review.js` handles individual reviews,
  `research_code_matching.js` handles matching integration/accounting, and
  `research_reporting.js` builds retrieval counters.
- Use the README module map to find the owner of a change. Prefer extending an
  appropriate existing module over duplicating logic or adding generic layers.
- Keep existing `AgenticLoop` delegation methods and injection hooks working.
  Helpers that need run state receive it explicitly; keep callback bindings intact.
- Reject reused `AgenticLoop` instances before entering run cleanup. A rejected
  invocation must not drain or abort another invocation's resources. Isolate both
  synchronous and asynchronous observer failures from research.
- Derive public `completion` from actual candidate, omission and final-review
  coverage plus discovery, name and usage completeness. Missing diagnostics are
  incomplete, never implicit success. Completed processing is separate from
  confirmed paint facts; keep unknown/conflicting verification fields visible.
- Final verification transport must respect the scheduler's model concurrency
  rather than create an avoidable fallback burst. Page normalization reuse is
  run-local and must invalidate when the source text changes.
- Keep matcher transport in the run-local `matcher_batcher.js`. Concurrent settled
  batches share its limit; do not multiply provider concurrency per input batch.
  Restore original indices, keep every candidate's full evidence, bill each
  shared call once, and reject row IDs outside that candidate's allowed catalog
  rows. Empty catalog choices need no paid call. Report failed matching separately
  from a completed lookup with no code, including in the completion contract.
  Preserve validated sibling matches if another child fails. Donor-make catalog
  rows require candidate-owned source support even when no same-make row exists.
  When removing an attached code from a name, retain the exact separate code/name
  row from the fetched page and the full published finish-bearing alias. Never
  strip a numbered marketing name merely because its prefix resembles a code.
  Portuguese catalog localization must preserve a real Lazzumix label, exact
  full-name vocabulary, same maker, common matched code and compatible finish
  evidence. Retain the international alias and catalog provenance, and send the
  local record with the output evidence. Never translate an unknown name from memory.
- Reject exact character-decoding placeholders in `paint_name.js` before review
  and again in final formatting, because a source page can print the placeholder
  inside a real paint row. For a leading code token, require a separate code/name
  row from that same page before stripping it. Keep legitimate numbered shade names.
- Repeated gallery parsing belongs in `gallery_paint_rows.js`. Require repeated
  matching name/year captions and manufacturer headings. Preserve complete
  sections with qualifications, leave unparsed prose to the model, and retain
  local candidates in both page-analysis modes even if residual extraction fails.
- Put automated JavaScript tests in `tests/*.test.js`, including page-agent tests.
  Import implementation modules from their actual locations; update relative
  paths when moving files. Do not put tests beside production modules.
- Keep `evaluate_*.js`, database import scripts and the demo `test_api.js`
  recognizable as standalone tools. They are not automatic regression tests.
- `evaluate_load.js` measures separate worker processes against one coordinator.
  Report runner queue time, end-to-end latency, failures and unknown costs.
  Never reset shared account capacity between vehicles to improve benchmark times.
- Keep prompts and schemas in their existing dedicated directories. Historical
  directory names may still be required by file lookups or compatibility callers.
- Keep model-catalog evidence in `model_catalog.py` and `model_evidence.js`.
  Model records support applicability, not assumed market/exact-year availability.
  Preserve the three mandatory catalog lookups, safe OEM-code allowlist, and
  separation of local `catalogSources` from fetched-page counts and web URLs.
- Lazzumix's trailing parenthesized `(B)`/`(E)` formula layers may be ignored for
  exact-name identity lookup, including known slash annotations. Preserve bare
  version letters and Roman numerals; do not apply that rule to BASF names or
  infer paint finish from the layer. Keep the original database descriptions.
- Full and triage review queues share `ReviewSlots` before assembling transport
  batches. Never freeze small batches behind that gate, or charge ordinary work
  against reserved completion slots. Keep one E ID for an owned passage and its
  shared text; K catalog references are separate from finish evidence IDs.
  Catalog-only finish proof goes through catalog selection and the final matcher.
- GPT output allowances include reasoning as well as visible JSON. Apply the
  route-specific allowance before both scheduler and cost admission, and send
  that same payload. Never treat missing usage as free. Absolute productive-stream
  expiry must not disable unrelated requests; idle/no-content failures still can.
- Keep default page downloads on `public_page_request.js`, validating socket DNS
  answers and every redirect. Never restore unchecked automatic redirects or a
  reader fallback for blocked destinations. `page_response.js` bounds decoded
  response bytes and stalled body reads. Oversized evidence fails explicitly;
  never silently truncate it. Injected network adapters are trusted integrations.
- Vehicle acceptance requires the public completion contract as well as reference,
  review, cost and time checks. A sole `no_model_linked_colors` limitation may
  pass acceptance when all processing checks pass, but the public result remains
  partial and every manufacturer-only or donor lead stays explicitly scoped.
  Unresolved names or discovery gaps are still incomplete. Keep historical
  reports unchanged and label their older acceptance rules when comparing them.

## Formatting and readability

- Match the surrounding style: two-space JavaScript indentation, CommonJS,
  semicolons, and generally single-quoted strings; four-space Python indentation.
- Separate logical sections with a blank line: setup, validation, request
  construction, execution, result handling and cleanup.
- Keep related declarations or assignments together. Avoid both long walls of
  code and a blank line after every statement. Preserve separation between
  functions and class methods; keep Python decorators attached to definitions.
- Separate built-in imports from local imports without changing initialization
  order. Preserve environment loading before modules that read environment values.
- Wrap long expressions and argument lists at natural boundaries. Keep new
  control flow readable rather than compressing several operations onto one line.
- Use concise comments to explain intent, evidence rules, deadline ownership,
  concurrency and cleanup constraints. Do not narrate obvious statements or add
  decorative comment banners.
- Never insert formatting whitespace inside prompt strings, template literals,
  SQL, regular expressions, embedded fixtures or other data. Formatting must not
  change their values.

## Refactoring and cleanup

- Keep organization/formatting changes behavior-preserving. Unless the task
  requests a functional change, preserve prompts, model routes, fallbacks,
  schemas, defaults, quotas, budgets, retries, source selection, finish filtering,
  output fields, accounting, callbacks and resource paths.
- Preserve asynchronous ordering, abort signals and job draining. Moving a
  method must preserve `this` bindings and strict-mode behavior where applicable.
- Search imports, exports, indirect callers, tests and standalone entry points
  before removing code. Being absent from the default `ai.js` route does not make
  an optional provider, fallback or compatibility API unused.
- Destructuring bindings may intentionally discard internal fields from output.
  Do not remove that filtering just because the local binding is never read.
- When removing confirmed unused code, remove its obsolete exports/constants and
  tests that cover only that code. Preserve shared helpers and active coverage.
- Keep changes inside this backend unless the user requests a broader scope.
  Preserve unrelated working-tree changes and other backend variants.

## Documentation and checks

- Keep the README quick to scan: run instructions, architecture diagram, numbered
  flow, module map, configuration, output/debugging and maintenance commands.
- Update the current README when module ownership, paths or commands change.
  Keep historical benchmarks and implementation notes in
  `docs/implementation-history.md` or `BASELINE.md`; label them as historical.
- Use the current directory name in commands. Root npm scripts may target a
  different backend; do not assume they run this implementation.
- Use the repository's RTK shell convention (`rtk …`, or `rtk proxy …` for raw
  command output).
- For cosmetic refactors, review the diff and use syntax/static comparisons to
  catch changed statements, literal values, exports or broken paths.
- Add or run tests only when requested by the user, respecting any existing
  authorization. Live evaluations call paid APIs and are separate from static
  checks and regression tests.
- Report which checks actually ran. Do not claim runtime equivalence, passing
  tests or preserved live accuracy based only on syntax/static checks.
