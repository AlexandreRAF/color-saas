# Operations and launch requirements

## Deployment layout

Build one immutable image using `deploy/Dockerfile`. Run its API, worker and
maintenance entry points as separate processes. Run migrations once per release
with a migration-only database role; never let every API instance migrate.
Retain the previous image for rollback. Initial migration failures require
inspection: MySQL DDL commits implicitly, and the runner intentionally does not
pretend a partially applied migration succeeded.

Use multiple API instances behind an HTTPS load balancer and edge DDoS controls.
Serve `dist/` through a CDN at the application origin. Exclude `/api/**` and
webhooks from every cache. `deploy/nginx.conf` demonstrates request-size limits,
trusted forwarding headers and unbuffered SSE with 75-second read timeouts.
The application emits three-second SSE heartbeat/snapshot frames and reconnects
streams periodically. Sessions and account data never belong in the CDN cache.

Use managed MySQL with durable commits, replication, encrypted backups and PITR.
Use managed authenticated Redis with TLS, persistence, failover and **noeviction**.
`deploy/redis.conf` is a TLS/persistence template, not a substitute for managed
replication and tested failover. Private network ACLs must restrict both services
to their application roles. Enforce TLS certificates, do not disable verification.
Set `TRUST_PROXY_HOPS` to the deployed topology and block direct public API access.

Worker subprocesses receive an allowlist of provider environment variables, not
account, MySQL, session, mail or Stripe credentials. The worker parent needs
database and queue permissions, but no email or Stripe secrets. API processes
need session/mail-encryption and Stripe secrets, not model credentials or the
mail delivery API key. Maintenance needs payment/mail keys, not model keys.
Inject secrets per service from a secret manager; `.env` is only a local aid.

Run with a read-only filesystem, unprivileged UID, dropped capabilities, PID and
memory limits and private temporary storage. Mount licensed SQLite catalogs
read-only outside source. Keep researcher debug dumping disabled. Python bytecode
writes are disabled in the subprocess. The existing page fetcher validates DNS
answers and every redirect, but deployment must also deny outbound private,
loopback, link-local and metadata networks for research subprocesses. On worker
hosts use a dedicated child UID/cgroup or sandbox launcher with its own network
policy: the worker parent's necessary database access must not become researcher
access. Test DNS rebinding, IPv6, redirects and provider-reader fetches before
release. This repository does not provision cloud firewall rules.

All research workers using one provider account must share the existing
`CAPACITY_SOCKET` coordinator. The supplied coordinator is a Unix-socket service:
place those worker processes on the same worker host, or supply a reviewed
cross-host coordinator/gateway before spreading one provider account across
hosts. Do not start independent coordinators with the same account quotas.
BullMQ's research-job cap itself is deployment-wide across hosts.

## Admission, concurrency and crash recovery

1. API acceptance commits MySQL job, reservation and dispatch intent together.
2. The maintenance leader publishes the application job ID into BullMQ.
3. BullMQ applies global concurrency; worker acquisition also locks a MySQL
   control row, checks running attempts and reserves deployment spending.
4. The worker starts GNU `timeout` in a detached process group. It bounds the
   actual researcher and its subprocesses even if the worker is killed.
5. Progress and heartbeat updates include the attempt ID. Terminal writes
   require the active attempt ID; late outcomes are failures, not billable work.
6. Recovery never replaces an attempt merely because its heartbeat is late.
   It waits for the external deadline plus a ten-second fencing margin. Only
   then can a bounded retry acquire a slot. Test this isolation on the deployed
   container runtime, including host suspension/recovery and SIGKILL.

Redis loss cannot create a new MySQL reservation. Pending MySQL jobs are scanned
regardless of their prior dispatch acknowledgement. If a completed/failed queue
entry blocks the same ID, reconciliation removes that entry before republishing.
Duplicate delivery cannot acquire a running or terminal job. Lowering concurrency
lets existing attempts drain: MySQL and BullMQ reject further acquisition above
the new cap. Deploy one common configuration and restart coordinator/workers
together. Do not run mixed queue/concurrency settings indefinitely.

The waiting deadline is cumulative across initial waiting and retry delays;
execution time is tracked separately. Accepted jobs retain their waiting deadline
while admission is paused. Technical transient codes permit exponential retry
with jitter. Unknown failures and completed empty results are never guessed to
be transient. Each attempt records its reserved ceiling and available measured
cost. Missing usage retains the whole allocation in the deployment budget.

`RESEARCH_RUN_CAP_MICRO_USD` is split across `RESEARCH_MAX_ATTEMPTS` so retries
cannot multiply a job's total spending allowance. The provider HTTP gate charges
conservative input/output ceilings before model requests and charges each Serper
attempt at the configured rate. It refuses unpriced models and never refunds
unknown request costs. The researcher's existing soft budget remains in force.
Provider price tables and token bounds still need release review, plus provider
account spending caps as defense in depth. A day is UTC and budgets are integer
millionths of USD. Allocation is conservative and may pause admission before
actual invoice spending reaches the cap.

## Routine commands

Run commands from the project directory with the appropriate admin database role:

```sh
node --env-file=.env scripts/admin.js status
node --env-file=.env scripts/admin.js pause
node --env-file=.env scripts/admin.js resume
node --env-file=.env scripts/admin.js refund-allocation re_ID PURCHASE_UUID 3 operator-id
```

Pause prevents new admission and acquisition; active work finishes. Keep API
login/history and payment reconciliation running during provider incidents.
SIGTERM stops worker acquisition and allows work to finish within the configured
grace period. A final abort kills the process group. Interrupted work is recovered
from MySQL after fencing. Do not reset jobs to queued manually while an old
process may still execute.

Partial refund allocations are immutable operator decisions recording a credit
quantity and operator identifier, not browser-provided quantities. Validate the
refund, purchase and contract before recording one. An unresolved allocation
keeps reconciliation pending and raises an error for monitoring. Full refunds
reverse the pack once. A dispute hold and refund overlap are capped at the pack
quantity; a won dispute restores only credits not otherwise reversed. Never
rewrite ledger entries to repair balances. Use reviewed compensating adjustments.

Stripe creation retries use the internal purchase ID as idempotency key. An
uncertain Checkout request older than 23 hours goes to review; automatically
reusing a key after Stripe forgets it could create a second session. Reconcile
such a purchase by locating its Stripe metadata and recording the session under
an operator-reviewed procedure. Do not grant credits based on screenshots or a
success redirect. Preserve accepted event records until processed.

## Monitoring and alerts

Collect structured stdout as JSON with retention and access controls. Logs allow
only event, timestamp, request/job/attempt ID, state, code, duration and count.
No request bodies, passwords, email codes, raw provider errors or payment payloads
are logged. Limit infrastructure access logs as well: original job IDs in paths
must expire with operational telemetry and must not link retained research.

Use `/health/live` for process liveness and `/health/ready` for database/Redis
readiness. Do not use model provider uptime as API readiness. Probe externally
from Brazil and another region, recording API availability separately from
research outcomes. Export aggregate SQL/Redis metrics using a monitoring-only
role; `scripts/admin.js status` provides a diagnostic snapshot. Setting an
independent `METRICS_TOKEN` enables `/internal/metrics` for authenticated private
Prometheus scraping. Keep that path off the public proxy; request counters are
per API process, while job, spending and reconciliation gauges come from MySQL.

Alert on:

- API 5xx, readiness failures and latency; queue depth and oldest cumulative wait.
- Research duration/outcome, late heartbeat, deadline kill and retry counts.
- Provider circuit pauses and daily budget allocation versus configured caps.
- Pending Stripe-event age, reconciliation failures and purchases in review.
- Email delivery exhaustion, stuck reservations and ledger/snapshot mismatches.
- MySQL replication/PITR lag, backup failures, Redis memory, persistence errors
  and replication health.

Maintenance pauses admission if financial snapshots differ from ledger sums or
reservation counts. Page the operator and investigate before resuming. Do not
automatically overwrite a financial snapshot merely to silence an alert.

## Backup, restoration and rollback

Initial targets are **RPO ≤5 minutes**, **RTO ≤60 minutes**, and core API
availability **≥99.9% per calendar month**. They must be measured and verified;
this implementation does not establish those service levels.

Before launch and at least quarterly:

1. Restore an encrypted MySQL snapshot and replay binlogs to the recovery point
   on an isolated network. Record actual data loss and restoration duration.
2. Reapply the independently retained deletion-request journal and run retention
   cleanup **before** opening reads. Expired history must remain inaccessible.
3. Reconcile ledger sums, reservations, purchases and Stripe state. A restore can
   lose acknowledged writes within the RPO; investigate missing jobs using
   permitted recovery records, identify affected users and communicate losses.
4. Restore/rebuild Redis, apply queue concurrency, then reconcile MySQL jobs.
   Fence pre-restore worker processes before admitting replacement work.
5. Verify authentication, session revocation, ownership, payments, queued jobs,
   terminal results and financial integrity. Run external readiness probes.
6. Reopen in stages, retain the incident record and measure recovery targets.

Backups need an explicitly configured expiry (`BACKUP_RETENTION_DAYS`) in the
backup service. Application configuration alone cannot delete external backups.
Keep the deletion journal outside the same recovery failure domain, with its
own access policy and retention. Legal holds require documented exceptions.

For application rollback, deploy the previous compatible image; do not reverse
financial migrations or discard outbox rows. Use additive schema migrations,
dual-version staging verification and a tested rollback release pair. Pin image
digests and CI action SHAs in the organization's release pipeline after choosing
the exact registry artifacts; the supplied templates pin runtime/service versions.

## Reference contracts

- [BullMQ deployment-wide concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)
- [Stripe webhook durability and signatures](https://docs.stripe.com/webhooks)
- [Stripe Checkout sessions](https://docs.stripe.com/api/checkout/sessions/create)
- [OWASP Argon2id guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
