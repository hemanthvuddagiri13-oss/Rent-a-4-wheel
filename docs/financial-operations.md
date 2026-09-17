# Financial operations

Capture, fulfillment, authorization and refund are separate facts. A captured
Payment never becomes FAILED. Reservation.financialDisposition is a one-way
stop on fulfillment; cancellation or a full-refund disposition cannot reopen.
Database triggers enforce payment monotonicity, immutable provider intent and
cancellation/financial termination monotonicity.

Every provider mutation has a FinancialOperation committed first, with an
immutable canonical SHA-256 fingerprint, original request payload and key.
Provider IDs are reused. A timeout or database failure leaves the operation
recoverable and keeps its refund balance reserved. Known IDs are retrieved;
unknown outcomes older than 23 hours require provider discovery. Failure to
discover them becomes REVIEW, visible on the admin reservation page. It never
grants permission to submit a new charge/refund with a fresh key.

The lock order is event (when processing a webhook), vehicle, reservation,
operation. Inventory acquisitions/refreshes, checkout, financial decisions,
cancellation, refunds and trip activation use the same vehicle/reservation
coordination. No database transaction spans a provider mutation. Operation
leases fence provider-response persistence and its business projection in the
same transaction. Stale calls use the original provider key and cannot commit
after takeover. Required compensations are reconstructed from the durable
operation and terminal reservation, including deposits finishing after cancel.

Rental success claims PAYMENT_FAILED as durable recovery inventory with a fixed
30-minute deadline before attempting the deposit. Retry never replaces this
with an invisible null-expiry transient hold or extends the deadline. Timeout
claims a refund disposition and its remaining balance before contacting Stripe.
Deposits use the charge's capture_before, never an estimated network lifetime.
Authentication-required intents are retained and authenticated through the
customer recovery UI. A deliberate retry after a terminal decline creates a
new deposit attempt; network retries resume the original one. Superseded or
terminated authorizations are released by recovery.

All trip activation, including emergency transitions, checks the financial
gate under the same lock used by refunds. Missing/expired required deposits,
pending full refunds and financially terminated reservations block activation.
The ordinary start route additionally rechecks the complete trip gate there.

## Workers

Configure CRON_SECRET. GET or POST each endpoint with
Authorization: Bearer <CRON_SECRET>:

- /api/cron/financial/stripe-events
- /api/cron/financial/reconciliation (also expires holds/recovery deadlines)
- /api/cron/financial/refunds
- /api/cron/financial/deposits
- /api/cron/financial/outbox

vercel.json schedules all five every minute. Other hosts must install equivalent
schedules. Verify the hosting plan supports that cadence. Workers are bounded
and can overlap: tokens fence claims and completion. Monitor failed invocations,
REVIEW operations, failed refunds and FAILED outbox messages. A successful HTTP
response with a nonzero pending/failed count is not proof all work completed.

Outbox rows claim exclusive leases. A stable Notification row freezes recipient,
subject and body before delivery; provider retries use its original outbox ID.
Transport or provider errors never mark delivery SENT. After the provider's
safe replay window, ambiguous delivery requires manual reconciliation.

## Deployment and verification

Apply all existing migrations unchanged plus
20260916220000_durable_financial_operations. The new migration preserves
payments/refunds, invalidates old estimated deposit deadlines, and lazily adopts
existing provider IDs. Migration does not create provider operations or issue
money movement. Recovery must retrieve legacy authorizations before trip start.

The Financial verification Actions workflow uses PostgreSQL 17, fresh migrations,
seed, typecheck, lint, two complete test runs (including populated migrations),
and production build. Concurrency tests use synchronization barriers, separate
Prisma clients/backend PIDs and observed PostgreSQL lock waits; HTTP tests send
real requests to the route handlers. Provider tests use deterministic fakes and
injected database failures, not live Stripe transactions. Stripe test-mode browser
verification and deployment monitoring remain separate release requirements.
