# Final Phase 5 compatibility correction

This batch is limited to the three final compatibility findings. It does not
constitute Phase 5 acceptance, production approval, or permission to merge PR #5.
Live payments and payouts remain disabled.

## Historical refund opening evidence

`RefundCompatibilityEvidence` is an additive, append-only supplemental record,
uniquely keyed by the historical journal and refund. Version 1 validates the
rejected `f0255dc` marketplace allocation algorithm against the original payment,
frozen snapshot, actual refund, balanced journal lines and effective approved
host debit/credit journals. It records the algorithm version, source identities
and fingerprints, reconstruction inputs, validation result, and cumulative
opening allocation. Historical journals are never rewritten.

The reservation/financial guard serializes reconstruction, incremental posting,
certification and payout checks. Certification fingerprints include compatibility
evidence. New refunds use actual posted historical allocations as their opening
amounts and keep the corrected monotonic incremental rule. Replay produces no
additional journal or supplemental record.

Missing approval evidence, unsupported host-changing entries, conflicting
payment/refund data, equal-time ambiguous journal ordering, negative/unexplained
lines and unbalanced input fail closed. They create `REFUND_COMPATIBILITY_REVIEW`
with the source journal and required investigation. Accounting remains incomplete
and payout eligibility is refused. Closing a queue item alone cannot authorize
it. No migration fabricates approval or overwrites history.

The rejected-schema upgrade test deploys the exact `f0255dc` schema, executes its
actual ledger/allocator/certification code to produce debit and credit histories,
then deploys every later additive migration. The generated current Prisma client
omits only the later `allocationEvidence` column while using the historical
schema. Current schema constraints remain enabled. Separate service tests inject
ambiguous/unbalanced historical reads to exercise fail-closed reconstruction
without disabling database protections. The Phase 4 upgrade remains independently
covered; Phase 4 did not have the marketplace allocation engine.

## Worker outcome contract

Shared results expose attempted, committed/processed, failed, stale, review,
quarantined, uncertain, skipped and disabled counts. Processed means committed,
not merely attempted. Review/uncertain are diagnostic dimensions and may refer
to the same delivery; consumers must not add them to infer distinct deliveries.
Community responses contain explicit notification, retention and channel child
results plus the aggregate. A child failure preserves earlier committed work.

Statuses are SUCCESS, PARTIAL_FAILURE, FAILED, DISABLED and NO_WORK. A success
with failures/review/uncertainty is PARTIAL_FAILURE. Both PARTIAL_FAILURE and
FAILED return HTTP 503 and cause a nonzero dispatcher result. Partial failures
emit CRON_PARTIAL_FAILURE; complete failures emit CRON_FAILED. Disabled/no-work
emit CRON_IDLE, which refreshes scheduler liveness without claiming work completed.

Schedulers should retry the next bounded invocation on their normal schedule
with backoff and alert on persistent failures. They must not blindly replay
provider sends: accepted deliveries stay accepted, and uncertain Twilio outcomes
stay in REVIEW until independently reconciled. The dispatcher also rejects a
failure result incorrectly wrapped in HTTP 200 and reads at most 64 KB of JSON.

## Checkout retries

Both identical-request returns revalidate booking/legal admission under the
shared release/reservation fence. A closed gate returns HTTP 409 with
`success:false`, `status:HISTORICAL_CHECKOUT_NOT_ELIGIBLE`,
`historicalCheckout:true` and `paymentEligible:false`. This response preserves
the finalized fingerprint, history and compensation access without creating or
dispatching another financial operation. An eligible identical retry succeeds
without re-signing or regenerating an agreement artifact.

## Verification and deployment

The initial debit regression failed specifically on immutable allocation
certification; the worker regression failed on hidden nested review; the route
regression returned HTTP 200 after booking disablement. None were unrelated
fixture-validation failures in the final reproductions.

Linux CI checks out the exact final SHA, runs fresh and both historical upgrade
paths, seed, Next type generation, typecheck, lint, production build, security
audit, both full suites, and five consecutive runs of the new compatibility,
worker and retry groups plus the existing adjustment/refund/provider concurrency
groups. Windows subprocess restrictions are not counted as deployment proof.

Use the existing direct migration wrapper. On migration failure keep admission
and live finance disabled, preserve the database/provider evidence and correct
forward with an additive migration; do not edit issued SQL or financial journals.
The production approvals, real-provider verification, operational monitoring,
backup/PITR, retention and security gates documented by Phase 5 remain required.
