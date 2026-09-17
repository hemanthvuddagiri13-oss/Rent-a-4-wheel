# Correction Batch 1E

The additive migration is `20260919010000_financial_ownership_and_fingerprint_versions`.
Earlier migrations are unchanged.

## Refund retirement

Authoritative succeeded, failed and canceled refunds retire their operation in the
same reservation-locked transaction. Retirement revokes an in-flight poll token;
its result and error handlers cannot overwrite the terminal projection. Claims
also acquire the reservation lock and reject terminal refunds. The due query joins
the authoritative refund **before** applying the 25-row limit. Legacy uncertain
refunds stay in operator review rather than automatic creation.

## Provider ownership

The database's `ProviderObjectOwnership` primary key serializes competing claims
for one Stripe identity. Kind, reservation and non-null payment, deposit, refund
and originating operation identities must agree. Deposit release operations are
references to their original authorization, not competing owners. Ownership
records outlive projection changes. Existing conflicting identities are marked
BLOCKED with visible reconciliation cases; the migration does not erase them.

Case adoption additionally verifies Stripe capture method, purpose, customer,
reservation, amount, currency, original payment, available immutable payload
metadata and operation-key lineage. Reservation/customer/amount alone do not
identify an unknown rental payment. Captured manual deposit intents cannot become
rental payments. Active operation leases must finish before operator adoption.

## Case amount repair

Rental/refund cases use their identified payment/refund records. Deposit cases
use an identified deposit or the original authorization payload. Release cases
follow the immutable target identity to that original authorization. Distinct
conflicting candidates or missing evidence become NULL amount/currency, displayed
as unknown. The repair does not infer generation ownership from timestamps or
rewrite audit history. Missing evidence can be escalated/assigned. Adoption of
unknown terms additionally requires an already-bound provider ID and exact
original operation lineage; settlement remains a separate privileged decision.

## Cancellation compensation

Cancellation and authorization observation share the vehicle/reservation lock.
Cancellation plans releases for all known deposit attempt identities and the
current legacy deposit identity in the same transaction. Observation plans the
same obligation if the identity arrives after cancellation. The deterministic key
`deposit-release:<original-intent-id>` identifies one authorization generation;
the generation number is also retained when known. Workers retrieve/cancel that
exact target and never create another authorization to release it.

## Booking fingerprint versions

Version 1 omits timezone; version 2 is the existing Batch 1D canonical hash with
timezone. Existing rows are marked version 1 by migration, including Batch 1D
hashes, which the upgrade recognizes without changing their meaning. New rows
default to version 2.

Only unfinished CHECKOUT_HOLD rows without checkout or payment activity upgrade.
Under the reservation lock, exactly one matching draft and a complete persisted
tuple must reproduce either the old hash or the existing timezone-aware hash.
The stored booking zone is canonicalized. This representation-only upgrade
preserves revision, UTC instants, selections, frozen prices and payment identity.
Finalized, paid, canceled and historical identities are never rewritten. Missing
or inconsistent evidence returns a review error.

## Verification coverage

`batch1e-financial.test.ts` uses real PostgreSQL and fake Stripe boundaries. It
terminalizes 25 refunds through reconciliation and executes later work through
the real recovery worker. It covers terminal observation fencing, lease takeover,
cross-kind rejection and successful evidence-based rental adoption. Independent
connections and observed PostgreSQL lock waits prove overlapping ownership and
cancellation/observation transactions.

`migration-batch1e.test.ts` starts at the exact Batch 1D schema, repairs populated
release/legacy-deposit cases and invokes the real case service for verification
and settlement. `booking-legacy-browser.test.ts` creates a hold/draft before the
timezone schema, applies subsequent migrations and resumes/submits in real
Next.js/PostgreSQL/Chromium with differing server/browser/business timezones.

The existing CI pipeline runs fresh migrations, seed, typecheck, lint, all tests
twice (including all populated-schema upgrade tests), then the production build.
Live Stripe/SCA browser verification and deployment configuration checks remain
separate from these controlled-provider tests.
