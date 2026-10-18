# Color

Brazilian vehicle paint research with durable accounts, credits, jobs and Stripe
payments. Public pages use HTML/CSS; the authenticated interface uses React. The
API is Express, application records live in MySQL, and BullMQ uses Redis for
dispatch. The existing researcher is called through a subprocess adapter without
modifying `src/agentic_researcher/`.

This is an application implementation, not a production availability claim.
Production deployment, service credentials, catalog data, legal disclosures,
load testing and disaster-recovery drills remain launch prerequisites. See
[operations](docs/operations.md), [privacy](docs/privacy.md) and
[verification](docs/verification.md).

## Local setup

Requirements: Linux, Node **24.18.1**, npm, Python 3, GNU `timeout`, MySQL 8.4 and
Redis 8. Use a dedicated development database and Redis instance. Windows workers
are not supported: process-group termination is part of the recovery protocol.

```sh
npm ci
cp .env.example .env
# Edit .env: connection URLs, independent random keys and test provider credentials.
npm run migrate
npm run build
npm start
```

Terminate HTTPS at a local reverse proxy; use the same origin for public assets
and `/api`. `PUBLIC_URL` must be HTTPS even locally because session cookies are
always Secure. The Express process listens on `PORT` behind that proxy.

In separate terminals:

```sh
node --env-file=.env src/agentic_researcher/capacity_server.js
npm run maintenance
npm run worker
```

Maintenance applies BullMQ's deployment-wide `AGENT_CONCURRENCY` (default 4).
Workers refuse to start against a different queue setting. It dispatches durable
outbox records, recovers expired executions, delivers mail, reconciles Stripe,
checks balances and removes expired research. Only one maintenance coordinator
holds the MySQL advisory lock at a time. Use a process supervisor with restart
and external monitoring; a researcher error does not stop the API.

The researcher needs read-only paint catalogs:

- `LAZZUMIX_DATABASE_PATH`: Lazzumix paint identity SQLite database.
- `BASF_DATABASE_PATH`: BASF paint identity SQLite database.
- `BASF_MODELS_DATABASE_PATH`: model palette database, included in the existing
  researcher at its configured default path.

The first two catalogs are absent from this checkout. Provision authorized
catalog artifacts outside the source tree. Their `paint_codes` tables must
contain the schema expected by the existing researcher. The worker rejects
missing files at startup. Provider credentials are `SERPER_API_KEY` and at least
one of `OPENAI_API_KEY` / `OPENROUTER_API_KEY`. The application never runs a paid
benchmark during installation or tests.

## Payments and mail

Create two Stripe **test-mode**, one-time BRL prices matching the server-owned
catalog in `src/app/config.js`: 10 credits at R$19.90 and 30 at R$49.90. Configure
their price IDs and the webhook signing secret. Prices are validated before
creating Checkout. Changing a pack is a server code/configuration change.

Point Stripe events at `POST /api/stripe/webhook`. Supported events include
Checkout completion, asynchronous payment success/failure, session expiry,
refund changes and dispute changes. The success redirect never grants credits.
Event IDs and object IDs are saved, then maintenance retrieves current Stripe
state. Raw payment payloads are not stored. Stripe's current state determines
fulfillment and adjustments; event arrival order does not.

Mail uses a Resend-compatible HTTPS transactional provider. The outbox encrypts
recipient and code content until delivery or expiry. Retries are bounded and
use provider idempotency keys. Verification codes and reset tokens appear in
the message body, never in URLs. Monitor delivery-exhaustion events.

## Application behavior

- Registration grants three credits once. Email verification unlocks research
  and purchases. Sessions use Argon2id password verification, opaque random
  cookies, digest storage, absolute expiry and CSRF checks.
- Every submission requires a user-scoped `Idempotency-Key`. One transaction
  checks eligibility, queue capacity and balance, reserves a credit, creates
  the job and inserts its outbox record. Reuse with different input fails.
- Results, terminal state and credit settlement commit together. Database
  uniqueness prevents repeat settlement. Partial, unknown and technical
  outcomes release the reservation. Only structured complete results are
  billable. The current researcher's empty palettes are partial, so they
  release credits; no empty-array heuristic produces a charge.
- Queued jobs can be cancelled atomically against acquisition. Accepted work
  survives browser closure, API restarts and Redis loss. Failed attempts have
  bounded retry/backoff and cost records.
- History URLs use `/app/#job/<id>`. Status, SSE, JSON downloads and exports all
  enforce ownership and the saved expiry. SSE rechecks sessions and history
  every three seconds; the UI also polls. Private API data is `no-store`.
- Credits affected by refunds/disputes are withheld once, even when both
  affect a purchase. Spent credits create debt and block new reservations.
  Accepted jobs continue. Partial refunds require an explicit operator credit
  allocation; see the operations runbook.

## Checks

```sh
npm run check
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Integration tests require disposable infrastructure. They create and drop their
own uniquely named database; the configured MySQL user needs `CREATE DATABASE`
permission. Redis **database 15 is flushed**; never point this at a shared or
production Redis instance.

```sh
TEST_DATABASE_URL=mysql://root:password@127.0.0.1:3306/mysql \
TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm run test:integration
```

CI runs syntax, unit/API, integration, build and dependency checks with MySQL
and Redis service containers. Application checks deliberately exclude protected
researcher files. Its own benchmarks remain separately maintained.

## Code map

| Area | Location |
| --- | --- |
| API composition, authentication and schemas | `src/app/api.js`, `auth.js`, `validation.js` |
| Admission, settlement, retries and history | `src/app/jobs.js` |
| Research isolation, output validation and budget gate | `src/app/research-adapter.js`, `research-child.js`, `provider-budget.js` |
| Queue, worker and coordinator | `src/app/queue.js`, `worker.js`, `maintenance.js` |
| Checkout, event storage and reconciliation | `src/app/payments.js` |
| Mail and retention | `src/app/email.js`, `privacy.js` |
| Versioned schema and migration runner | `migrations/`, `scripts/migrate.js` |
| Public pages and authenticated UI | `public/`, `web/` |
| Deployment templates | `deploy/`, `.github/workflows/ci.yml` |

The [specification](SPEC.md) remains the product and reliability contract.
