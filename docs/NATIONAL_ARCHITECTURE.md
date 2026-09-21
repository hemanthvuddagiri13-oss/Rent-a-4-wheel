# National marketplace architecture — Phase 5

Rent A 4Wheel is a peer-to-peer marketplace. Hosts are independent vehicle providers, not employees or branch offices. Hosts store, maintain, deliver and retrieve vehicles and perform physical handoffs. The platform supplies marketplace discovery, booking, payments, verification, agreements, support and claims workflows. Initial public launch is intended for Texas, followed by controlled state expansion. This intent is not a release approval.

## State release authority

The additive national migration creates all 50 states and DC as `DISABLED`. It does not infer locations for existing hosts, vehicles or reservations. Unknown geography blocks new admissions until verified. There is no production-approved mode in this schema or application. Texas can be configured for `STAGING`; it receives no special treatment in shared policy logic. Production denies all state admissions in Phase 5.

Each state requires a current, versioned gate for entity/foreign qualification, legal agreements, insurance, taxes, privacy/retention, operations, payments, host payouts, airport/municipal restrictions, and separate host, guest and vehicle eligibility. `STAGING_READY` means reviewed for staging only. It is not a claim about laws, insurance coverage or public launch readiness. Evidence references identify external review; software does not supply or certify that review.

The newest effective version wins for each gate. Expired or revoked versions block admission; the engine never silently falls back to superseded approvals. Future versions do not supersede current versions before their effective date. Versions and evidence are immutable; revocation is terminal. Disabling or revoking gates uses the same PostgreSQL advisory fence as provider dispatch. An operation already dispatched finishes under its existing authority; disablement waits for that bounded dispatch, then blocks subsequent effects. No claim is made that an external request can be recalled after submission.

Admissions include host onboarding, vehicle activation, public visibility, holds, checkout, rental/deposit creation, confirmation, trip start (including financial emergency gates) and payouts. Refunds, releases, reversals, existing-trip returns, claims and reconciliation retain their existing authorization and safety rules. They do not require the disabled state's admission gates. A late payment observed after disablement must enter refund disposition instead of confirming a booking.

New holds freeze jurisdiction identity and gate evidence. Subsequent admission checks evaluate current authority using that frozen state. Moving a vehicle does not move an existing reservation into another jurisdiction. Signed rental agreement evidence includes the reservation's jurisdiction snapshot and exact quoted pricing policy.

SUPER_ADMIN changes require a fresh purpose-bound security code and a reason. The operations API supports `jurisdictionMode`, `jurisdictionGate`, `revokeJurisdictionGate`, `pricingPolicy` and `revokePricingPolicy`. No action supports production approval. Mode changes alone cannot satisfy missing gates. Policies and gate versions are preserved in audit records.

## Sample pricing and frozen allocations

`MARKETPLACE_V1` is an integer-cent calculation version. Its immutable policy includes host commission and guest service fee percentages, flat/minimum/maximum amounts, subscription plans, completed-trip volume tiers, jurisdiction adjustments, protection pass-through, payment-processing allocation, tax bases, host risk reserve, promotion funding and settlement/loss rules. Effective dates and review evidence belong to each state-specific policy version.

All rates remain SAMPLE / UNAPPROVED. Real insurance, claims, payment, tax, fraud and support costs are not established here. Subscription membership and completed-trip counts are read by the server. A subscription plan's monthly amount is disclosed in frozen calculation evidence; this engine does not silently add a subscription charge to a rental or claim to implement recurring subscription collection.

Processing fees use the explicitly configured rental-after-discount base, avoiding circular fee-on-fee calculations. Subscription and volume reductions apply to commission basis points before flat/minimum/maximum constraints. Policies that exceed host earnings are refused. Tax treatment is an explicit unapproved configuration, not a statement of any state's law.

The quote records the full configuration, policy ID/version/hash, applied facts, every calculation line and approval label. Checkout freezes that quote in the existing immutable FinanceSnapshot. Later configuration, membership, volume or vehicle-location changes do not recalculate confirmed bookings, signed evidence, host earnings, refunds, journals or payout entitlements. Legacy snapshots and approved migrations are preserved.

For new marketplace snapshots, collected money posts to host, tax, protection, processing and risk-reserve liabilities. Sample platform fees remain in `UNSETTLED_PLATFORM_FEES`, never revenue. Deposits remain authorization memorandum entries or settlement liabilities. Production revenue recognition, reserve release and recurring subscription billing require separately reviewed implementations and cost/coverage approvals; they are not enabled by a sample pricing policy.

Refunds use the frozen loss policy and cumulative, monotonic highest-averages cent allocation. Full refunds reverse refundable frozen fees, protection, tax and reserve allocations, recover the platform-funded discount allocation, and retain processing obligations as liabilities with platform refund cost. Partial refunds cannot double-count previous allocations. This is a versioned staging calculation, not a legal promise that every insurance or tax provider will accept that refund treatment. Real contractual treatment must be approved in a new version before launch.

Checkout separates platform service fees, insurance/protection, processing, tax, deposits, extras and discounts. Host financial statements additionally disclose commission, host processing, risk reserve and earnings. No live charges, transfers or payouts are enabled.

## Verification and outstanding work

National tests exercise all twelve gates, unknown/disabled states, expired/revoked versions, absent production mode, onboarding/search/hold denial, and real PostgreSQL admission-versus-disable/revoke contention using separate connections and observed database lock waits. Pricing tests exercise exact sample amounts, fee caps, subscription/volume facts, every cumulative refund penny, immutable database snapshots and liability journals, and refund-accounting recovery after state disablement.

These tests do not prove state legal compliance, live-provider behavior, real insurance/tax approval or production readiness. Phase 5 remains in progress until the complete migration, route, browser, security and repeated-concurrency verification matrix passes at the final commit.
