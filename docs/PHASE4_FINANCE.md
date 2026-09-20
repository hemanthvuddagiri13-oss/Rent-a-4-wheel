# Phase 4 finance architecture

This branch extends the approved reservation, payment, refund, deposit, case and provider-dispatch systems. No live Stripe transfers or payouts are enabled. FINANCE_SANDBOX_ENABLED must be true and STRIPE_SECRET_KEY must begin with sk_test_. A live key always fails closed.

## Provider architecture

Stripe Connect Express dashboard accounts use Stripe-hosted requirement collection, application-paid fees and application loss responsibility. The platform requests transfers capability and manual payout scheduling. Account links are created server-side with canonical refresh and return URLs. Redirect completion is not verification. Account metadata, current requirements, manual scheduling and available provider balance are checked before dispatch. No bank account, card or taxpayer identifiers are stored in the finance projection.

References: [Connect controller properties](https://docs.stripe.com/connect/migrate-to-controller-properties), [separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers), [hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding), [manual payouts](https://docs.stripe.com/connect/manual-payouts).

## Accounting invariants

- Integer minor units and explicit currency; every journal has at least two positive, one-sided lines and balances at database commit.
- Issued journals, their lines and financial documents are immutable. Later corrections are separate reversing journals. Appending to a previously issued journal is rejected.
- Journal keys and immutable canonical fingerprints make accounting replay idempotent.
- Rental collections allocate host payable, commission, service fees, taxes and platform-funded discounts separately. Deposit authorizations are memorandum entries, never host earnings. Prior deposit generations and releases remain evidence.
- Additional charges and deposit captures remain settlement liabilities until authorized allocation. Refund and chargeback allocation follows the reservation's approved frozen policy. Recoveries after transfer create host receivables and approval-gated reversals.
- Currency groups are never combined into a payout. Provider IDs are bound to their immutable operations by database ownership enforcement.

## Payout authority and state

New batches freeze eligible reservation earnings and immutable item amounts. Each earning has at most one active payout item. Eligibility requires a completed trip, accepted return evidence, resolved financial/operational review, no dispute or legal/security hold, approved current host and Connect account, frozen approved settlement policy, elapsed delay and positive net earnings.

State progression: PLANNED -> TRANSFERRED -> PAYOUT_PENDING -> PAID. A confirmed failed/canceled bank payout becomes PAYOUT_FAILED. Independent super-admin step-up authorization may create a new bank generation only after retrieving authoritative failure. An undispatched batch may be VOIDED; any dispatch evidence prevents voiding. Full transfer recovery becomes REVERSED, and partial reversals retain exact reversed and bank-paid amounts. A PAID batch is not downgraded by a later response; discrepancies become retained cases.

The same reservation/vehicle guards used by the approved financial core are acquired in sorted order, then the host finance and operation guards. The provider call runs on a pinned PostgreSQL session. Durable intent, including the configured Connect country, precedes Stripe; DISPATCHED precedes the call; provider acceptance is committed separately from application projection. Unknown dispatched outcomes are discovered or quarantined, never blindly recreated. Never-dispatched quarantined intents may resume only after independent step-up authorization verifies the absence of dispatch evidence; their original key and request remain unchanged. Failed schedule deliveries have an audited retry action in the operator queue. Recovery of an existing outcome continues after suspension. Independently authorized compensating reversal can recover funds from a suspended host, but cannot change its immutable transfer or destination.

## Scheduling and reconciliation

Authenticated routes under /api/cron/payouts/:worker expose accounting, recovery, schedule, reconciliation and historical-audit workers. Existing /api/cron/financial/outbox executes finance_schedule messages through the existing exclusive lease mechanism. vercel.json declares execution schedules; deployers must provision CRON_SECRET and a plan that supports their cadence.

Scheduling advances the host cutoff and writes the outbox intent atomically. Outbox completion, batch creation and continuation are one transaction fenced by the current lease. Discovery rotates fifty earnings at a time; checked small balances carry forward and are revalidated so a threshold across multiple pages is not stranded. Invalid policies defer the affected host instead of starving later scheduled hosts. Timezone-aware weekly, twice-monthly and monthly cutoffs use the local 09:00 clock.

Urgent recovery is separate from historical auditing. Provider discrepancies remain visible, with no automatic write-off. Historical checks compare payments/refunds, retrieve owned transfers/payouts/reversals and post available processing-fee evidence. Lost disputes require independent, step-up-authorized frozen-policy allocation. Backlog metrics raise deduplicated in-app finance alerts; unexplained differences and ledger imbalances block the relevant money movement.

## Rules, access and documents

Commission versions support host, vehicle, category and default scopes, effective windows, percentage, fixed booking fees and min/max commission. Basis-point calculations use integer half-up rounding. Tax versions use exact jurisdiction, separate rental and service-fee rates, taxable extras and approval-backed exemption references. No default commission is represented as business-approved. External tax-provider rules cannot be approved without an implementation; the boundary is explicit. Checkout quote terms freeze at financial commitment and later versions cannot rewrite them.

Finance agents inspect finance records; administrators propose rule and adjustment changes; high-risk authorization requires a current independent super administrator and one-use finance verification code. Host employees require current membership and an explicit finance grant. Host suspension blocks new payout management. Customer/host/admin document downloads resolve current authorization and verify the stored SHA-256 hash.

PDFs are immutable versioned private snapshots with currency and timezone. Monthly/yearly boundaries use local midnight, including DST. Host summaries use accounting recognition date and label that basis; they are not legally final tax filings. Tax/KYC status is a safe provider projection, not storage of SSNs or banking details.

## Verification and release gates

The financial-verification workflow runs fresh migrations, seed, typecheck, lint, two full test passes, five financial-concurrency passes, production build and existing phase regression suites. Browser journeys use real Next.js/PostgreSQL/Chromium at 375, 390, 430, 768, 1024 and 1440 pixels. Provider fixtures exercise failures without live money movement. Concurrency assertions use independent database connections and synchronization barriers, including observed PostgreSQL lock waits.

Validation is still in progress. Consult the final commit's workflow and delivery report for exact results; this document is not a green-build claim.

Production gates remain live Stripe onboarding/transfer/payout/reversal and webhook verification, deployed cron and alert validation, business approval of commissions/settlement/loss policies, professional jurisdiction/exemption/tax review, provider-confirmed tax-document and 1099 workflow, operational reconciliation procedures and capacity validation for large accumulated balances. The source-level live-money guard must not be removed as part of deployment configuration.
