# PHASE 1 FINAL CLOSURE

## Scope and architecture

This closure continues PR #1 on `claude/tender-goodall-6aobde`, from `0f3f6fb67cb18eb6e30defda49af815c6172f5be`. It does not merge the PR or introduce Phase 2 UI.

Every Stripe mutation in Phase 1 passes through `runOperation`: customer creation, rental PaymentIntent creation, deposit authorization, refund creation, and deposit PaymentIntent cancellation. Retrieval, list/discovery, webhook signature verification, and charge-expiration retrieval are read-only paths. Customer operations are user-scoped and are deliberately excluded from the reservation provider-ownership trigger.

`withOperationGuard` opens a private Prisma client with a one-connection pool. It acquires session-level PostgreSQL advisory locks derived from two sorted 64-bit portions of SHA-256. Reservation operations use their vehicle scope, matching inventory lock ordering; customer operations use their operation ID. Event-driven execution acquires the event scope first. Dispatch verifies that the physical backend still owns the scope locks.

The guard covers authorization validation, the bounded Stripe request, dispatch receipts and result projection. Validation includes exact operation identity, immutable fingerprint, current token, database-clock lease expiration, executable state, release target, original deposit ownership and generation, and current release authority. Refund dispatch also verifies the captured rental's provider ownership. Deposit creation verifies the current generation and open reservation. A conditional lease renewal cannot revive an expired lease. Stripe requests have an eight-second timeout and no automatic SDK retries.

Reservation writers acquire the corresponding transaction advisory guard before vehicle/reservation row locks. Event takeover and completion writers acquire the event guard. Database BEFORE triggers also protect operation leases, provider ownership, payments, refunds, deposit state, reservations, event leases and trip-gate evidence. Bypass writers use nonblocking advisory acquisition and fail with a serialization error instead of waiting while holding a row the dispatcher needs. This prevents a row/advisory-lock inversion. Normal transactions wait for the guard and re-read state.

`DIRECT_DATABASE_URL` must point directly to PostgreSQL or a session-mode pooler when the ordinary URL uses a transaction-mode pooler. The dispatch connection cannot use transaction pooling. The application rejects the explicit `pgbouncer=true` setting and verifies backend lock ownership before dispatch; deployment must still validate the actual pooler mode. These connections require a bounded deployment connection budget.

## Crash and quarantine semantics

An immutable provider operation and key exist before any provider call. `FinancialDispatch` records DISPATCHED before dispatch, then SUCCEEDED with provider identity/result, or UNCERTAIN with a redacted error code. Acceptance evidence commits before the domain projection so a projection rollback does not erase the provider result. Quarantine records include dispatch evidence.

If quarantine or takeover wins the guard, the stale dispatcher makes no mutation call. If dispatch wins, the competing writer waits or is rejected; after the guard releases, quarantine sees the committed dispatch evidence. Session locks are released in `finally`, and disconnect releases them after failures. Process death releases PostgreSQL locks but does not prove that an already-dispatched network request failed. Such requests remain uncertain and recover using their original immutable key/identity. Known IDs are retrieved. Unknown create outcomes replay only within the conservative 23-hour retention window, then require discovery or operator reconciliation. Cancellation always targets the original PaymentIntent and original cancellation key. A terminated reservation with an unknown earlier deposit attempt uses discovery rather than creating a new authorization.

A network request already dispatched before process death cannot be recalled. Idempotency handles that physical failure window; the guard prevents a new dispatch from an already-stale or quarantined worker. Neither mechanism is presented as a substitute for the other.

## Operation-level reporting

Every release execution returns `{operationId,status}` with processed, failed, quarantined or uncertain. Request-local collection is reporting only, not a mutex. Nested compensation and recovery paths participate in the same collection; a map deduplicates operation IDs. Deposit workers expose separate deposit and release totals plus the operation list. All authenticated financial cron responses expose collected release totals and IDs. A successful successor's durable cancellation is reported as processed, rather than letting a stale predecessor misreport the operation as uncertain.

Tests cover late authorization discovered during recovery, including an actual HTTP call to the cron route: exactly one processed release, zero failed/quarantined/uncertain, and one operation ID. The blocked-backlog test quarantines 25 blocked releases and executes the following valid release on the next invocation. Blocked records are removed from the due queue.

## Phase 1 acceptance audit

| Area | Enforcement and evidence |
| --- | --- |
| Email-code authentication | Cryptographic codes, expiry, per-email/IP issuance limits serialized in PostgreSQL, bounded attempts under an email guard, single consumption; newest consumed code cannot expose an older code. Parallel request/guess regressions are included. |
| Authorization | Server sessions refresh current active user/role from the database. Host affiliation is restricted to active HOST/HOST_EMPLOYEE accounts, then tenant ownership is checked. Customer routes check reservation ownership. Emergency override also rechecks the current super-admin in the action transaction. |
| Inventory, holds and pricing | Vehicle/reservation lock ordering, blocking-state exclusion constraint, transient-only expiry filtering, locked hold refresh/cleanup, server quote and immutable booking/checkout fingerprints. Existing race and browser regressions remain. |
| Payments and refunds | Captured-payment monotonicity, immutable durable operation intent, atomic refund balance reservation, provider status reconciliation, cancellation compensation, late-payment disposition and terminal-state protection. |
| Deposits and trip start | Current operation/generation binding, Stripe capture deadline and capturable amount, required-deposit fail-closed checks, financial locking before trip start. Quarantined/rejected/wrong-owner documents cannot satisfy the ordinary gate. Gate-evidence database writes share the reservation guard. |
| Webhooks, recovery and outbox | Event token fences, executable secret-protected recovery routes, exclusive outbox claims, stable delivery keys, durable compensation intent and observable operation outcomes. |
| Identity documents | Private storage, owner/tenant/reviewer access, read audit, image sanitization, production fail-closed malware scanning, quarantine unavailable to non-owner reviewers. Checkout attachment conditionally rechecks document ownership in its committing transaction. |
| Agreements | Attorney-review gate, stored version/content/hash/signer/time snapshots; database trigger prevents rewriting signed evidence or replacing an attached signed PDF. First PDF attachment remains allowed. |
| Emergency overrides | Current SUPER_ADMIN, explicit confirmation/reason, one-use step-up code, mandatory financial start gate, audit and trip events; forced start/completion updates the Trip record. |
| Migrations and logs | Additive migration preserves historical records, fingerprints and reconciliation evidence. Existing populated-schema tests are retained. Dedicated dispatch clients use the same database-error redaction as the main client. Provider payloads are not logged. |

## Verification contract

The financial verification workflow checks the exact pushed SHA using PostgreSQL 17: all fresh migrations, seed, generated route types/typecheck, lint, the entire suite twice (including every existing populated upgrade and browser test), five consecutive runs of the dispatch-concurrency and blocked-release suites, and a production build. The final task report identifies the exact run and results; this document does not substitute for a green run.

Concurrency tests use separate PostgreSQL sessions, synchronization barriers, observed database lock waits and a controlled provider ledger. They cover takeover during retrieval, expired/replaced tokens, both quarantine orderings, blocked ownership, bypass writers, two competing application executions, accepted cancellation with response loss, database projection failure after acceptance, late recovery and HTTP counts, and shared refund/deposit guards. Existing refund-balance, trip-start, hold, webhook, crash recovery and outbox tests remain in the suite.

Local Windows process restrictions can prevent Prisma's schema-engine subprocess, Chromium and the normal build worker from starting. Fresh SQL migrations, seed, typecheck/lint and database tests can run locally; the Linux CI run remains required for the complete migration/browser/build verification.

## Production-only gates

Before a production deployment: validate live Stripe test-mode/SCA and different-card recovery; exercise all deployed CRON_SECRET-protected schedules and alerting; validate the direct/session-pooled dispatch database connection and connection budget; integrate the malware scanner (production uploads currently fail closed); obtain attorney approval of actual legal documents; and resolve actual quarantined financial records through the audited workflow. Do not equate controlled provider tests with live Stripe acceptance testing.
