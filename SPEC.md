# Color SaaS Specification

## Purpose and Scope

Build a reliable application for users in Brazil to research vehicle paint colors,
view source-backed results, and purchase research credits. These requirements
describe the intended application, not features already implemented.

Integrate the existing `src/agentic_researcher/` through an application adapter.
Changes to that component require a separate, explicit request.

## Architecture and Stack

- Use HTML, CSS, and JavaScript for public pages, including home, policies, and
  about. Use React for the authenticated color application.
- Use Node.js and Express for the API, MySQL for durable application data, and
  Redis with BullMQ for background research scheduling and coordination.
- Keep the API, research workers, and maintenance tasks in one codebase, running
  as separate processes. A research failure must not crash the API.
- Serve static assets through a CDN. Route API traffic through an HTTPS reverse
  proxy or load balancer with request limits and DDoS protection.
- MySQL is the source of truth for accounts, sessions, credits, purchases, jobs,
  and results. Redis is not the authoritative store for balances or results.
- Keep databases and Redis on private networks with authentication, encryption
  in transit, and service-specific access permissions.
- Use a transactional email provider for verification and password resets.
  Deliver messages asynchronously with bounded retries and delivery monitoring.

## Authentication and Sessions

- Require only email and password to register. Verify email ownership with a
  short-lived, single-use code before allowing research or credit purchases.
- Email codes verify account ownership; they are not required on every login.
  Use separate single-use, expiring tokens for password resets.
- Hash passwords with Argon2id using reviewed parameters. Store verification
  codes and reset tokens as secure digests. Limit issuance, resends, and attempts.
- Use opaque, cryptographically random session tokens instead of JWTs for this
  browser application. Store token digests and session metadata in MySQL.
- Send tokens in `Secure`, `HttpOnly`, `SameSite=Lax` cookies. Apply CSRF protection
  to state-changing browser requests. Never put tokens in URLs or local storage.
- Allow multiple sessions. Sessions survive server restarts and expire absolutely
  after 14 days by default, configurable through `.env`. Activity does not extend
  that deadline. Rotate tokens after login or privilege changes.
- Support current-session and all-session logout. Password resets revoke all
  existing sessions. Check expiry and revocation on every authenticated request.
- Rate-limit registration, login, verification, and password reset across all API
  instances. Avoid unnecessarily revealing whether an email has an account.

## Credits and Query Admission

- One billable research query costs one credit. Grant three free credits once
  when creating an account; they become usable after email verification.
- Maintain an append-only ledger of grants, purchases, reservations, consumption,
  releases, and payment reversals. Use integer credit amounts.
- Available credits exclude active reservations and credit debt. Use database
  transactions with locking or conditional updates so concurrent requests cannot
  reserve the same credit.
- Require a client-generated idempotency key, scoped to the user, for submission.
  The same key and payload return the same job; a different payload with that key
  is rejected. Enforce uniqueness in MySQL.
- In one MySQL transaction, validate eligibility, reserve a credit, create the
  job, and create an outbox record for dispatch. Commit all changes or none.
- Return `202 Accepted`, an opaque job ID, and a status URL after durable acceptance.
  Users without available credits cannot submit new research.
- Enforce configurable per-user and deployment-wide outstanding-job limits.
  Reject excess requests before reserving credits.

### Billing Outcomes

| Final outcome | Credit treatment |
| --- | --- |
| Completed research with usable results | Consume the reserved credit once. |
| Completed research that genuinely found no colors | Consume the reserved credit once; display a clear empty result. |
| Technical failure, exhausted retries, or execution timeout | Release the reserved credit. |
| Partial or incomplete research | Save available results, label them incomplete, and release the credit. |
| Cancellation before execution or expiry while waiting | Release the reserved credit. |

Classify outcomes from structured researcher output, not error text or an empty
array. Provider outages and failed searches must not become billable "no colors
found" results. Unknown outcomes are nonbillable.

Persist results, terminal job state, and credit settlement in one MySQL
transaction. Settlement must be safe to repeat, with a database constraint
preventing multiple settlements for one job. Closing the browser does not cancel
research or affect billing. Initially, user cancellation is available only while
queued; cancellation and worker acquisition must be atomic.

## Durable Queue and Research Workers

- An outbox dispatcher publishes accepted jobs to BullMQ with the application
  job ID for deduplication. Retry interrupted dispatch; do not assume MySQL and
  Redis can commit together.
- Configure **global research-agent concurrency through `.env` using
  `AGENT_CONCURRENCY`, defaulting to `4`**. This caps simultaneous research jobs
  across the entire deployment, not per process or server.
- Apply the limit centrally through BullMQ. All instances use the same deployment
  configuration; one coordinator applies queue settings. Changes take effect
  through controlled restart or deployment. Lowering the limit lets existing
  work drain before admitting more jobs.
- This limit applies to complete research runs, not the researcher's internal
  model-call parallelism. Respect existing internal limits and enforce shared
  provider rate limits across workers where required.
- Enable Redis persistence, suitable replication/failover, and a no-eviction
  policy. Monitor memory, persistence failures, and replication health.
- Retain durable job and dispatch information in MySQL so pending work can be
  reconciled after Redis loss. Periodically reconcile stalled jobs, unsettled
  reservations, and completed jobs with missing queue acknowledgements.
- Assume at-least-once delivery. Duplicate jobs must not repeat completed runs,
  duplicate results, or settle credits twice. External API calls may still be
  repeated after interruptions, so bound retries and record each attempt's cost.
- Retry transient failures with exponential backoff and jitter, subject to a
  configurable attempt limit. Do not retry invalid input or completed empty results.
- Enforce configurable queue-wait and execution deadlines. Stop actual worker
  activity, including subprocesses and network requests, when execution expires.
- Use heartbeats, execution leases, and attempt identifiers. Reject writes from
  superseded attempts. Stop or isolate stale execution before replacement so
  recovery does not bypass the concurrency cap.
- On shutdown, stop taking jobs and allow active work to finish within a bounded
  grace period. Interrupted work must recover without duplicate settlement.
- Set spending caps per run and deployment period. Pause admission during severe
  provider failures or budget exhaustion while keeping login, history, and payment
  reconciliation available. Already queued work retains its waiting deadline.

Use explicit states: `queued`, `running`, `retry_wait`, `completed`,
`no_colors_found`, `partial`, `failed`, `cancelled`, and `expired`. Terminal states
are immutable. User-requested reruns create new jobs and credit reservations.

## Application Pages and Progress

- Provide a form with all required researcher inputs, clear validation, available
  credits, and the one-credit billing policy before submission.
- Persist job state and a progress snapshot. Show the stage, successfully fetched
  pages, browser/search uses, and AI worker calls. Distinguish total calls from
  the number running simultaneously.
- Provide authenticated status retrieval and Server-Sent Events (SSE) for live
  progress, with polling as a fallback. Reconnect using the current snapshot.
  Page reloads and disconnects must not lose or restart a job.
- Configure proxy timeouts and SSE heartbeats. Recheck access during long-lived
  streams and close them on session revocation or history expiry.
- Show colors in a table with sources, confidence, and uncertainty. Rank using
  structured evidence and confidence from the researcher; source count alone
  must not imply verified accuracy.
- Distinguish waiting, completed, empty, partial, and failed states. Explain
  whether the reserved credit was consumed or released.
- Provide paginated history and a stable URL per job during its history window.
  Check ownership and expiry for every result, status, download, and event request.
  An unguessable ID is not authorization.
- Use private/no-store responses for authenticated research data and prevent CDN
  caching of private API responses. Show a configurable low-credit reminder and
  link to purchase packs.

## Credit Purchases and Stripe

- Sell fixed credit packs through Stripe-hosted Checkout. Determine pack contents,
  currency, and price on the server; never trust browser-supplied prices or quantities.
- Create an internal purchase record and use an idempotency key for Checkout
  session creation. Separate test and production Stripe credentials.
- Never grant credits from a success-page redirect. Fulfill only after verified
  server-side payment success, including delayed payment methods.
- Verify webhook signatures against the raw request body. Persist accepted events
  before acknowledging them, then process asynchronously. Return an error if
  persistence fails so Stripe can retry.
- Deduplicate event IDs and enforce one fulfillment per payment. Handle duplicate
  and out-of-order events; retrieve current Stripe state when needed.
- Grant credits and mark the purchase fulfilled in one MySQL transaction.
  Periodically reconcile unsettled purchases with Stripe to recover missed events.
- Record refunds and disputes as ledger adjustments. Full refunds reverse the
  pack's credits once; partial refunds require an explicit recorded credit quantity.
  Hold disputed credits once, restoring them if the dispute is won or reversing
  them if lost. A refund and dispute must not reverse the same credits twice.
- Record credit debt if affected credits were already spent. Prevent new
  reservations until it is covered; do not rewrite ledger history or interrupt
  previously accepted research. Explain adjustments to the user.
- Never receive or store raw card numbers or CVCs. Retain only necessary account,
  purchase, and Stripe identifiers. Email and purchase metadata remain personal data.

## Data Storage, Retention, and Privacy

- Save research outcomes in MySQL, including partial results and structured
  failures. Record researcher version and relevant run configuration without secrets.
- Users can access active jobs and, by default, their results for seven days after
  termination. Configure this window through `.env`; store `history_expires_at`
  when each job terminates. Configuration changes apply to future terminal jobs.
- Enforce expiry during reads even if cleanup has not run. Use scheduled,
  retryable cleanup to remove user associations and expire progress records.
- Retain research beyond its history window only after removing direct and
  indirect user links. Review inputs, free text, timestamps, logs, original job
  IDs, and payment/ledger references for re-identification paths. Clearing
  `user_id` alone is insufficient; delete data that cannot be safely anonymized.
- Separate retained anonymous research from account and billing records. Define
  its purpose and retention period instead of keeping it indefinitely by default.
- Document retention separately for accounts, verification records, sessions,
  identifiable results, anonymous research, operational logs, financial records,
  and backups. Financial retention follows applicable obligations; the seven-day
  history window is not a universal deletion deadline.
- Apply Brazil's LGPD and applicable ANPD rules and guidance. Document processing
  purposes, legal bases, service providers, hosting locations, and international
  transfers. Provide access, correction, export, and deletion-request processes.
- Do not send account emails, session tokens, or payment information to the AI
  researcher. Minimize any personal data in research inputs.
- Restrict and expire backups on a documented schedule. After restoration, reapply
  deletion requests and retention cleanup before reopening access.

## Security Controls

- Validate server inputs against explicit schemas for types, lengths, ranges,
  and allowed fields. Limit request sizes. Client validation improves usability
  but does not replace server validation.
- Use parameterized SQL, least-privilege database accounts, output escaping, and
  a Content Security Policy. Treat AI output as untrusted data, never raw HTML.
  Validate source-link URL schemes before rendering links.
- Use HTTPS, shared endpoint-specific rate limits, edge DDoS protection, secure
  headers, and a restrictive same-origin/CORS policy.
- Sanitization cannot guarantee freedom from prompt injection. Treat inputs,
  fetched pages, and model output as untrusted. Separate instructions from data,
  restrict tools, validate outputs, and enforce budgets independently of the AI.
  Models must not control authorization, credits, or payment decisions.
- Run workers with restricted permissions and credentials. Prevent SSRF through
  outbound network controls covering private, loopback, link-local, and cloud
  metadata addresses, including DNS resolution and every redirect. Combine
  application checks with network isolation where possible.
- Use a secret manager or protected environment injection in production. Never
  commit real `.env` files, expose secrets to the frontend, or log passwords,
  tokens, raw payment payloads, or unnecessary research content.
- Validate configuration at startup and fail clearly on missing or invalid values.
  Keep dependencies supported and check vulnerabilities before release.

## Configuration

Use environment variables, loaded from `.env` locally and protected deployment
configuration in production. During implementation, provide an `.env.example`
with documented, non-secret values.

| Variable | Initial default | Meaning |
| --- | --- | --- |
| `AGENT_CONCURRENCY` | `4` | Global maximum simultaneous research jobs; positive integer. |
| `SESSION_TTL_DAYS` | `14` | Absolute session lifetime. |
| `HISTORY_RETENTION_DAYS` | `7` | User history window after a terminal outcome. |
| `EMAIL_CODE_TTL_MINUTES` | `10` | Verification code lifetime. |
| `PASSWORD_RESET_TTL_MINUTES` | `15` | Password-reset token lifetime. |
| `MAX_OUTSTANDING_JOBS_PER_USER` | `2` | Queued, running, and retry-wait jobs per user combined. |
| `RESEARCH_QUEUE_MAX_OUTSTANDING` | `100` | Deployment-wide outstanding-job cap. |
| `RESEARCH_QUEUE_WAIT_TIMEOUT_SECONDS` | `900` | Maximum cumulative waiting time, including retry delays. |
| `RESEARCH_JOB_TIMEOUT_SECONDS` | `120` | Execution deadline per attempt; does not extend internal researcher deadlines. |
| `RESEARCH_MAX_ATTEMPTS` | `2` | Total attempts, including the first execution. |
| `LOW_CREDIT_THRESHOLD` | `1` | Available balance at or below which to show a purchase reminder. |

Also document database/Redis connections, email and Stripe credentials, public
application URL, provider limits, spending caps, and retention schedules. Spending
caps and production retention periods require explicit values, not unlimited
defaults. Validate related settings together, including shutdown grace periods
and execution deadlines. Tune initial queue and timeout defaults through load tests.

## Reliability, Deployment, and Operations

These initial production targets must be validated before launch; they are not
claims about current performance:

| Measure | Initial target |
| --- | --- |
| Core API availability | At least 99.9% per calendar month, measured by external probes. |
| Accepted-job durability | Across process crashes and Redis outages, acknowledged jobs remain recoverable and reach a visible terminal outcome. |
| Credit correctness | No duplicate grants or settlements, or spending of reserved credits. |
| Disaster recovery data-loss window (RPO) | At most 5 minutes for MySQL, followed by job and payment reconciliation. |
| Disaster recovery restoration time (RTO) | Restore core service within 60 minutes of a declared incident. |

- Measure research success, execution time, and queue wait separately from API
  availability. Establish research latency/capacity targets from representative
  load tests; researcher benchmarks are not service guarantees.
- Use automated encrypted backups and point-in-time recovery. Test restores
  before launch and at least quarterly, including credits, purchases, deletion
  records, and outstanding jobs.
- A disaster restore can lose changes within the RPO window. Reconcile affected
  payments and balances, identify missing jobs where recovery records allow,
  and communicate unresolved losses; do not claim zero data loss for this case.
- Select hosting and redundancy to meet these targets: multiple API instances,
  replaceable workers, and managed MySQL/Redis failover or an equivalent tested
  arrangement. Validate latency for Brazilian users and provider calls.
- Provide separate liveness and readiness checks. Never acknowledge data that
  was not durably stored. Redis outages can delay dispatch of durable jobs but
  must not lose reservations; enforce normal queue capacity and waiting deadlines.
- Emit structured logs and metrics with request, job, and attempt IDs. Restrict
  access, redact sensitive fields, and enforce telemetry retention.
- Alert on API errors, queue age/depth, lost worker heartbeats, timeouts, provider
  failures, AI spending, webhook lag, ledger reconciliation failures, stuck
  reservations, backup failures, and database/Redis resource exhaustion.
- Maintain runbooks for pausing admission, draining workers, restoring backups,
  safely replaying operations, reconciling payments, and responding to incidents.
- Separate development, staging, and production data, secrets, and payment modes.
  Pin runtime/dependency versions and build reproducible deployment artifacts.
- Use versioned, deployment-compatible database migrations, executed once per
  deployment. Maintain a tested application rollback path that preserves jobs
  and financial records.
- Require CI checks and staging verification. Cover admission races, duplicate
  submissions, worker crashes, Redis recovery, duplicate/reordered webhooks,
  session revocation, authorization, and history expiry. Use provider mocks and
  Stripe test mode for routine tests; run paid benchmarks separately with budgets.

## Reference Guidance

- [BullMQ global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)
- [Stripe webhooks](https://docs.stripe.com/webhooks)
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [ANPD glossary](https://www.gov.br/anpd/pt-br/documentos-e-publicacoes/glossario-anpd)
