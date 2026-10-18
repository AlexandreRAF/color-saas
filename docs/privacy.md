# Data inventory and privacy release review

The application provides data access/export, correction-request intake and
deletion-request intake through the authenticated account page. The operator
must supply a public privacy contact, review correction requests, verify identity
where appropriate, and document request fulfillment. Do not publish the draft
policy pages as a finished legal notice.

Apply the LGPD and applicable ANPD guidance to the actual controller and service
arrangement. This document records implementation decisions and required operator
decisions; it does not establish a legal basis or a universal financial retention
period. Consult the [LGPD text](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
and [ANPD guidance](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/glossario-anpd)
when approving the production register.

| Record | Purpose | Retention and deletion |
| --- | --- | --- |
| Account email and password hash | Account access, ownership and service delivery | Active account; pseudonymize after a deletion request and completion of accepted jobs. Financial subject identifier remains during financial retention. |
| Verification and reset records | Prove ownership and recover access | Digest only; single use, five attempts, configured 10/15-minute defaults. Delete after use or expiry. |
| Session digests and CSRF digests | Browser authentication and request integrity | Absolute expiry, default 14 days. Delete expired/revoked rows. No IP/user-agent fingerprint stored. |
| Encrypted email outbox | Asynchronous verification/reset delivery | Remove encrypted content on delivery, expiry or exhausted attempts. Delivery metadata uses `OPERATIONAL_RETENTION_DAYS`. |
| Identifiable research inputs, progress, outcomes and attempts | Fulfill a research request and show its history | Active jobs plus saved terminal expiry, default seven days. Enforce reads immediately; scheduled cleanup deletes data and original job IDs. |
| Idempotency tombstones | Prevent accidental repeat spending after history cleanup | User plus client-generated key, with no retained input hash or original job ID after job deletion. Delete with account cleanup. |
| Anonymous research | No secondary research purpose enabled | **Not retained.** There is no anonymous data warehouse or indefinite retention. |
| Purchases, credit ledger and allocations | Fulfillment, dispute/refund reconciliation, accounting | Explicit `FINANCIAL_RETENTION_DAYS`; development example is 1826, not a legal determination. Pending/review payments require resolution. Finance role access only. |
| Privacy/deletion journal | Fulfill rights and reapply deletion after restoration | `DELETION_AUDIT_RETENTION_DAYS`, with off-site deletion journal under operator control. Remove free-text details when no longer needed. |
| Operational logs and metrics | Security and incident response | Explicit `OPERATIONAL_RETENTION_DAYS`, enforced in telemetry storage; avoid email/content. No researcher debug artifacts. |
| Backups | Disaster recovery | Explicit `BACKUP_RETENTION_DAYS`, enforced by backup lifecycle policy; encrypted, access controlled and tested. Reapply deletions before restored service is accessible. |

Deletion removes research outputs, inputs, progress, attempt records, outbox
dispatch records and settlement-to-job links. The append-only ledger keeps its
independent random credit reference for financial correctness, but loses the
join back to deleted research. Clearing only a `user_id` is deliberately not used
as anonymization. Query inputs and AI output can contain unexpected personal
text; deleting them is safer than claiming they have been anonymized.

Financial records and the pseudonymous account subject are not described as
anonymous. Purchases retain Stripe identifiers and can remain indirectly
identifiable under restricted finance access. Apply retention to these separately.
Deletion cleanup does not call external-provider deletion APIs: the controller's
fulfillment process must cover Stripe, transactional email, telemetry and backups
according to contracts and applicable obligations.

Before production, fill and approve a processing register containing:

- Controller legal identity, privacy contact and request escalation owner.
- Each processing purpose and applicable legal basis, including fraud prevention,
  contractual service delivery and mandatory financial recordkeeping.
- Actual hosting/database/Redis, CDN, mail, Stripe, model and search providers,
  their roles, DPA/subprocessor terms and precise hosting/processing countries.
- International transfer mechanisms and notices for each relevant provider.
- Production retention values, financial obligations and legal-hold procedures.
- Access, correction, export and deletion response procedures, evidence of
  fulfillment and the separately protected deletion journal used during restores.
- Incident response ownership and regulatory/data-subject notification assessment.

The researcher receives only bounded vehicle fields. Account email, password,
cookies, session digests, Stripe identifiers and payment metadata are absent
from its stdin and environment. Avoid personal data in free-text vehicle fields;
server schema validation is not a claim that personal text or prompt injection
can always be detected. The model cannot decide account access or ledger writes.
