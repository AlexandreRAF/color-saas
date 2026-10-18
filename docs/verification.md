# Verification and remaining launch gates

Application tests are independent of protected researcher tests. Routine tests
use provider mocks and signed Stripe test payloads; none performs paid research
or creates a real payment.

## Local verification, 2026-10-11

- 25 tests passed: 13 unit/API/subprocess tests and 12 database/Redis integration
  scenarios, including real process-group deadline termination and SSE revocation.
- Integration execution used temporary MariaDB 11.8.6 and Redis 8.0.2 instances.
  MySQL 8.4 CI has been configured but was not executed in this environment.
- Application syntax checks and the production frontend build passed.
- Production dependency audit reported zero vulnerabilities.
- Chromium checks covered the public home, authenticated research form and
  credit-purchase view at desktop and 390-pixel mobile widths, using browser-local
  API fixtures. No horizontal overflow was observed on the checked views.
- No paid researcher, live Stripe/email provider, production infrastructure,
  backup restore or load test was run. Protected researcher files were unchanged.

## Automated coverage

Unit/API tests cover configuration, vehicle schemas, structured outcome billing,
unsafe source URLs, confidence ranking, progress counters, credit/debt arithmetic,
refund/dispute overlap, encrypted mail, provider cost admission, authentication
requirements, no-store responses, same-origin enforcement and raw-body webhooks.

The database/Redis integration suite covers concurrent credit admission,
per-user outstanding limits, repeated idempotency keys, payload conflicts,
transactional outbox creation, repeat settlement, stale attempt rejection,
cancellation/acquisition races, interrupted-worker recovery, queue reconstruction
after Redis loss, global concurrency across multiple BullMQ workers, ownership,
history expiry, idempotency tombstones, duplicate fulfillment, debt and existing
reservations, one-time verification, persistent sessions, CSRF, absolute expiry
and password-reset revocation.

Local database verification can use a compatible MariaDB service, but CI targets
MySQL 8.4. Passing MariaDB tests alone does not validate MySQL failover, replication
or deployment-specific TLS. The CI workflow must run successfully in the target
repository before release.

## Staging acceptance

Run against production-equivalent MySQL, Redis, proxy and isolation settings:

1. Use Stripe test mode for Checkout, delayed payment success, failure, duplicate
   delivery, refund-before-completion delivery, full and allocated partial refunds,
   active/won/lost disputes, overlapping refund/dispute and missed webhook recovery.
2. Kill worker parents and provider subprocesses, interrupt MySQL commits, restart
   API instances and fail over Redis. Acknowledged jobs must reach one visible
   terminal outcome and exactly one credit settlement.
3. Confirm external execution deadlines kill all descendants, including during
   network stalls. Verify old hosts are fenced after suspend/resume or restoration.
4. Use representative vehicles and separate paid benchmark budgets to establish
   quality, latency and capacity. Tune the initial 120-second attempt and
   900-second cumulative waiting deadlines with evidence.
5. Test mobile/desktop, keyboard navigation, session expiry and revocation during
   SSE, history expiry during downloads, reconnect, polling and browser reload.
6. Validate provider-account shared quotas, conservative prices/token bounds,
   restrictive egress and DNS/redirect SSRF controls. Do not claim prompt injection
   is prevented by text sanitization.
7. Exercise restore/rollback runbooks and demonstrate RPO/RTO targets, external
   API probes and every required operational alert.
8. Finalize privacy/commercial notices and real retention/provider details before
   opening registration to the public.

## Infrastructure and product decisions still required

- Cloud/network resources, CDN, DDoS protection, TLS certificates, replication,
  backup storage, external metrics/alerts and deletion-journal storage.
- Licensed Lazzumix/BASF identity catalogs and real model/search credentials.
- Actual Stripe/mail accounts, verified sender, production prices and credentials.
- A cross-host provider coordinator if worker hosts share provider credentials;
  the included researcher coordinator uses a Unix socket.
- Legal identity/contact, provider locations, approved commercial terms and
  retention periods; public policy pages are visibly marked development drafts.

These are explicit launch gates, not claims that deploying the image alone
meets the production targets in `SPEC.md`.
