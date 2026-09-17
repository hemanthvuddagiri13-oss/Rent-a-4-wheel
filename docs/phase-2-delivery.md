# Phase 2 marketplace delivery

Base: main `9f0c067ed5fe2dd08dc7a4bfefa40517ac20848f` (PR #1 squash merge; identical tree to approved Phase 1).
Branch: `codex/phase-2-marketplace`.

Pull request: https://github.com/hemanthvuddagiri13-oss/Rent-a-4-wheel/pull/2. No automatic merge or production deployment.

## Implemented workflows

- Customer discovery excludes demo inventory/reviews. Search accepts city/area, dates/times, filters and sort. Time resolution uses the booking timezone and rejects invalid/ambiguous DST input. Approved availability and checkout remain authoritative.
- The existing booking wizard retains email-code authentication, server prices, extras/coupons, identity uploads, legal consent, Stripe payment and authenticated resume. Confirmation polls actual financial status and recorded amounts.
- Account reservations provide checkout resume, financial/deposit recovery and SCA, cancellation, private identity uploads, signed agreement/receipt downloads, pickup readiness, inspections, active trip, return and activity history.
- `/host` and `/host/profile` provide business applications and a dashboard. `/host/team` manages employees and vehicle owners. Owners grant/revoke access; managers manage the fleet; staff handle assigned trips. Server requests recheck current permissions. Suspended hosts lose workspace/document access.
- The listing workflow saves vehicle/pricing/rules, then collects photos, ownership/registration/insurance evidence and a signed listing agreement. New listings stay unavailable pending review. Edits increment the listing revision and require a matching signed snapshot and renewed approval.
- Host vehicle workspaces provide a month calendar, booking/block ranges, date blocking, availability controls and maintenance history/next service dates. Calendar writes share checkout's vehicle guard and reject overlap with live holds/durable bookings.
- Reservation workspaces provide clean-document review, physical identity comparison, both parties' inspections/photos and acceptance, keys, gate status, active rentals and return review.
- The existing trip gate remains authoritative. Key release checks approved prerequisites; start also requires recorded key handoff and revalidates current participant/state/financial eligibility under the reservation lock.
- Return completion requires both accepted reports with exterior/interior photos and nondecreasing mileage. Concurrent completion has one durable result. Undamaged completion atomically plans existing durable deposit-release operations. Damage enters review; no automatic additional charge is invented. Host/admin screens expose timing, mileage/fuel evidence and history. Admins can retain a claim or close an ended dispute without a charge.
- `/admin/marketplace` provides approvals, verification, disputes, maintenance/compliance alerts and audit history alongside existing legal/reconciliation tools. Listing review pages expose authorized files and signed PDFs.
- Agreements freeze content/version/hash, signature evidence and vehicle/reservation snapshots. Signed PDFs remain immutable across later edits; missing generation can resume. Approval requires a host PDF matching the current listing revision. Legal edits need a new version; enabling signatures requires replacement of draft text and a recorded attorney-approval reference. The application records that assertion; it does not independently authenticate an attorney.

## Preserved constraints

Financial intent, operation identity, replay safety, provider dispatch fencing, refund balance reservation, reservation exclusion and the trip-start financial lock remain authoritative. New operational writes must acquire the existing vehicle/reservation guards. Customer documents remain private and scan-gated. Draft legal content must say **NOT APPROVED FOR PRODUCTION — TEXAS ATTORNEY REVIEW REQUIRED** and cannot be signed before attorney approval.

## Files and scanner deployment

Private reads are audited. Non-owner identity/compliance reads require clean scan status. Only designated public listing photos may be unauthenticated, after scanning and approval. Images are re-encoded, stripped of metadata and bounded by byte/pixel limits.

`CLAMAV_HOST` and optional `CLAMAV_PORT` configure a trusted private ClamAV daemon using [INSTREAM](https://docs.clamav.net/manual/Usage/ClamdProtocol.html). Only an exact terminated clean result passes. Missing configuration, network errors, malformed/truncated replies, timeouts and size errors fail closed. Keep the daemon on a trusted private network because this TCP protocol does not authenticate clients.

The existing explicit development-only identity-upload opt-in still creates owner-readable quarantined files. Host compliance uploads follow that rule. Inspection uploads require a clean verdict even in development. Quarantined files are not automatically promoted; re-upload once scanning is available.

## Migrations

- `20260921010000_marketplace_workspace`: listing approval/location/rules, host-scoped owners, immutable agreement subject snapshots, private marketplace files, database rate limits and TripChecklist authority guard.
- `20260922010000_listing_revision`: positive listing revisions binding approval to signed snapshots.

Approved Phase 1 migrations are unchanged. Existing inventory defaults to approved; new host listings explicitly start pending/unavailable. Historical signatures are preserved; absent historical snapshots are not fabricated.

## Verification and limits

The Financial verification workflow runs fresh migrations, seed, Next type generation/typecheck, lint, the full suite twice, financial concurrency/backlog suites five times, and production build. It uploads marketplace-screenshots. Consult the workflow at the exact PR HEAD; older successful runs do not verify later code.

New tests cover real PostgreSQL tenant/employee/owner rules; checkout/calendar and simultaneous completion barriers with separate connections and observed lock waits; populated upgrades; socket scanner protocol/failure behavior; and real Next.js/PostgreSQL/Chromium host listing, quarantine/privacy, signing/revision/template changes, approvals and employee revocation. Customer/host browser journeys cover inspections, handoff, keys, gate-enforced start, active trip, return, completion and receipts. Discovery/account screenshots cover 375, 390, 430, 768, 1024 and 1440px; major operational pages have mobile/desktop captures with overflow/form-label assertions.

The real Next.js booking journey also visits vehicle details, uploads three documents, finalizes checkout with a signed rental PDF and reloads the same immutable reservation. It deliberately stops at the absent payment provider. The browser scanner is an explicit external-provider test double. The operational trip fixture supplies synthetic successful payment, clean identity and signed rental evidence. These tests exercise real application HTTP/storage/database behavior, not a live Stripe account or a deployed antivirus signature database. Existing booking-browser and financial crash/recovery suites remain intact.

## Production deployment gates

1. Texas attorney-approved legal language and recorded approval references.
2. Monitored private ClamAV engine with current signatures and deployed availability/security checks.
3. Stripe test-mode end-to-end cards/SCA/deposit/refund verification and production provider configuration.
4. Authenticated recovery/outbox schedules, alerts, reconciliation procedures and direct/session-pooled database connections required by Phase 1 locks.
5. Durable private storage, backups, retention/deletion operations, actual approved inventory and verified business contacts. Demo inventory is not publicly bookable.
