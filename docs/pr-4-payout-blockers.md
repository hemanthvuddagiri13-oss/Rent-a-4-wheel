# PR #4: stale accounting and outstanding bank movement

This correction is limited to payout decisions that previously trusted a mutable summary while newer provider or accounting evidence existed. Live Stripe finance remains disabled.

## Accounting authority

`finance-completeness.ts` compares all reservation payment/refund evidence, provider operations and accepted dispatch receipts, disputes, approved adjustments, immutable journals and HostEarning. The accounting worker certifies a versioned fingerprint only after those projections agree. Pending/uncertain refunds, quarantined operations, unmatched accepted receipts, missing journals, unallocated chargebacks and stale checkpoints fail closed. A failed checkpoint is explicitly INCOMPLETE and rotates through recovery rather than starving other reservations.

Eligibility and both transfer/bank dispatch use this check under the existing reservation and provider guards. The committed accounting checkpoint is also required before the financial-case settlement workflow releases a Phase 4 host reservation's return-review hold. Operator resolution cannot substitute for accounting. Recovery checks all existing earnings, including records that already have journals but whose provider evidence changed later.

The unpaid-batch correction policy is **hold, account, void, rebuild**. A changed entitlement never edits frozen items or an immutable provider request. Run real accounting, complete the authorized case workflow, then use the existing super-admin step-up `voidUndispatchedBatch` action to atomically void the old batch and release its items. That service rejects any dispatch evidence. The ordinary batch service freezes current eligible earnings in a new batch. The 13,500-cent batch remains retained and voided; the replacement is 9,000 cents after the approved 5,000-cent refund allocation. Once dispatch may have occurred, refund and chargeback accounting records a recoverable host receivable and hold instead of rewriting unpaid history.

## Bank movement authority

`payout-movement.ts` inspects every FINANCE_PAYOUT generation, including prior and quarantined attempts, dispatch receipts, operation results, provider ownership, pending webhook evidence, reconciliation issues and durable bank projections. `PayoutBankProjection` is committed with the bank result and journal. Durable provider acceptance with a failed projection is unresolved even if PayoutBatch still says TRANSFERRED. Reversal planning records an actionable hold in a committed transaction before rejecting; reversal dispatch repeats the same check on the pinned provider session.

Tracked amounts are distinct: transferred, pending bank, paid bank, reversed and reversal-reserved. Available Connect funds equal transferred minus paid minus pending minus reversed. Reservable funds additionally subtract reserved reversals. Reservation and dispatch use this same calculation. A database check forbids new negative materialized balances; reversal journals remain supported. Retrying a confirmed failed bank payout first checks every earlier generation, not only current batch state.

After a bank payout is confirmed paid, this batch has no funds to reverse. The approved receivable remains open for separately authorized collection; the system does not debit another batch or silently write off the loss. If Stripe authoritatively confirms failure before a paid projection, bank pending funds clear and the approved reversal can consume the remaining Connect funds exactly once.

## Migration and verification

`20260927010000_payout_projection_authority` is additive. It adds checkpoints, per-operation bank projections and pendingBankCents. Existing owned observed current generations can be backfilled. Uncertain generations require recovery. Existing deficit evidence is retained and quarantined; the new balance check is NOT VALID for historic rows but enforced on every new insert/update. Existing money and journals are never fabricated or silently rewritten.

The blocker tests use real PostgreSQL transactions, separate connections, database-side barriers and observed lock waits. External refunds are imported through real reconciliation and reviewed through the real settlement service. The stale dispatch is attempted before accounting. Crash tests inject SQL division-by-zero after durable provider acceptance, assert the still-TRANSFERRED summary, and count provider calls. Both rejection-first and recovery-first orders converge to paid=13,500, reversed=0, Connect memo=0 for a paid payout. Confirmed-failure recovery permits exactly one 4,500 reversal and leaves 9,000 tracked Connect funds. Tests also cover pending webhooks, multiple generations, multiple captures/refunds and concurrent over-reservation constraints.

The financial-verification workflow runs both full suites, the refund race group five times, the bank crash group five times, existing financial concurrency five times, all populated migrations, seed, typecheck, lint and production build. Consult the correction commit's CI and delivery report for exact results. Provider fixtures do not establish live Stripe readiness; deployed cron/alerts, capacity, approved business policies and professional legal/tax review remain production gates.
