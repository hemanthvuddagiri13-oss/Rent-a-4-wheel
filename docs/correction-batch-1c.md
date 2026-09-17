# Batch 1C verification map

The implementation uses one financial projection for status, confirmation and
trip eligibility. Fulfillment recovery only accepts checkout/recovery states;
REVIEW is a stop for human reconciliation, not permission to refund. Normal
cancellation and refunds inspect Trip records under the vehicle/reservation lock.

Deposit operations own explicit generations. Terminal observations cannot restore
authorization, renewal cancels only its observed intent, and a release is observed
as complete only after Stripe reports canceled. Legacy missing-ID outcomes are
quarantined rather than replayed with incompatible parameters. Known IDs remain
available for authoritative retrieval.

Booking drafts carry increasing revisions checked under the inventory lock.
Checkout stays immutable across Back, reload and Stripe returns. Only the opaque
reservation ID enters the URL; no identity data or document IDs enter browser
storage. Resume responses deliberately omit those fields.

Prisma invocations are sanitized at the shared client boundary. Application logs
contain static event labels and allowlisted error codes instead of raw exceptions.
DOB and license expiry must be valid ISO calendar dates before mutation.

Regression mapping:

- Operational-state payment replay and external partial refund: batch1c-financial.
- Terminal deposit, release failure and overlapping renewals: batch1c-financial.
- Staff cancellation/start lock race and unfinished Trip refund: batch1c-financial.
- Out-of-order booking revision requests: batch1c-financial (barriers/two clients).
- Real refund projection takeover and immutable provider ledger: batch1c-financial.
- >25-item worker backlog: batch1c-financial; actual worker-client seam corrected.
- Unpaid cancellation, deposit amount, partial/failed refund projections: batch1c-financial.
- Owner/customer/host/admin/anonymous, retry, cancel/start, provider/cron failure,
  redacted dates and Prisma errors: financial-http.
- Review/payment/Back and reload/Stripe-return: booking-browser, real React components
  in Chromium with controlled HTTP/provider boundaries. This is not live Stripe testing.
- Pre-ledger and Batch 1B populated schema upgrades: migration-financial-upgrade;
  original pre-Phase-1 migration test remains intact.

No live Stripe credentials, deployment changes, or merges are part of this batch.
The CI workflow must pass fresh migration, seed, typecheck, lint, every test twice,
and build before this batch can be reported complete.
