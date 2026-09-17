# Correction Batch 1D

## Booking time policy

Business settings expose an IANA booking time zone, default America/Chicago. Each reservation freezes its zone. Customer wall-clock times resolve through Temporal with disambiguation reject; nonexistent and repeated DST times return a recoverable 400. Bookings use whole-minute precision. Offset-bearing inputs must also represent a unique local minute. UTC instants are persisted; resume formats them in the reservation zone, never the browser or server zone. Calendar-day pricing uses the same zone.

Hold selections reject missing/inactive extras and invalid coupons. Accepted hold pricing remains frozen on refresh. Resume returns stored line amounts and quantities. Changing business settings does not reinterpret an existing draft's zone.

## Ordinary refund matrix

| Reservation / trip | Ordinary refund |
| --- | --- |
| Pre-trip, captured rental, OPEN | Partial or full within atomically reserved balance |
| Explicit terminal refund mandate | Remaining captured balance only |
| Any started unfinished trip | Rejected |
| ACTIVE, RETURN_IN_PROGRESS, COMPLETED, DISPUTED, UNDER_CLAIM_REVIEW | Rejected, including partial adjustments |
| REVIEW | Rejected until an authorized case resolution |

No post-trip adjustment action is introduced. A future claim/adjustment workflow must have its own authorization and audit policy.

PENDING and legacy-uncertain refunds reserve balance. Full pre-trip refund success transitions inventory to EXPIRED (existing cancellation states stay canceled), financial disposition TERMINATED, and persists deposit releases in the same transaction. Pending and partial refunds do not release inventory. Payment success is never downgraded and replay cannot reopen terminal disposition.

## Deposit ownership and compensation

The deposit binds an explicit operation ID and generation, matching provider intent, capturable amount, current provider status and expiration. Migration uses unique provider identity, not timestamps; ambiguous ownership is quarantined. Required unknown/unverified deposits fail the trip/confirmation gate.

Every authorization observation reacquires the reservation lock. Current terminal disposition or superseded generation creates an immutable deposit-release obligation in the same transaction as the observed projection. A crash before immediate compensation cannot lose this obligation. Release targets never change between retries.

## Operator workflow

/admin/financial-cases lists unresolved cases, operation counts, oldest pending work, failed refunds and dead-letter deliveries. Cases retain customer/reservation, type, amount/currency, original key, provider identity, evidence, assignment, attempts, error, resolution and audit history.

ADMIN/SUPER_ADMIN may assign, escalate, or verify provider identity/failure. The service rechecks active database privileges and requires a reason. Adoption retrieves Stripe and checks customer/payment binding, amount, currency and identity uniqueness. Missing results are never evidence of failure. Provider identities and retry obligations commit before any later projection, so adoption itself is resumable. Verified evidence remains in REVIEW until an explicit decision.

SUPER_ADMIN may authorize pre-trip settlement or release inventory after proven full refund; started/operational trips and unresolved outcomes are excluded. REVIEW alone never authorizes an automatic refund. Captured security deposits require claim review, not an automatic cancellation/refund.

## Recovery

Urgent operation queries use kind, actionable state READY/RETRY/POLL/RUNNING, due nextAttemptAt, expired/absent lease, bounded consecutive failures, priority, due time and creation time. financial_recovery_due_idx indexes kind/state/priority/nextAttemptAt/createdAt. Healthy polls reset the failure budget but retain total attempts. Twenty consecutive failures create a manual case. Historical OBSERVED entries do not occupy urgent batches.

The independent historical-audit cron runs hourly; existing urgent cron routes run each minute and require CRON_SECRET. Known legacy provider IDs are adopted through bounded anti-join scans. Outbox and Notification success/failure projections commit together only under the owning unexpired outbox token.

## Verification coverage

- batch1d-financial: operational refund rejection before intent, pending/partial/full inventory behavior, replay, separate-connection cancellation during provider authorization, durable release after observation, generation mismatch/quarantine, legacy uncertain balance and verified operator adoption, thousands of historical records plus executed urgent recovery.
- outbox-concurrency: replacement sender succeeds before old sender fails; both database projections remain SENT.
- migration-financial-upgrade: pre-1B, pre-1C and pre-1D populated schemas, uncertain FAILED refunds, preserved IDs/keys and ambiguous ownership.
- booking-real-server: real Next server + PostgreSQL + Chromium, no booking API interception, actual uploads and checkout, Tokyo server / Los Angeles browser / Chicago booking, DST rejection and boundary, selections, Back/reload/simulated authentication return, identity/revision/fingerprint persistence.

Live Stripe test-mode browser authentication, production scanner/provider configuration and operational deployment verification remain separate production checks. The real-server development test uses the existing explicit development-only payment simulation and quarantined-upload opt-in; neither is enabled in production.
