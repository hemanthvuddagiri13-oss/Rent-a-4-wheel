# Phase 5 baseline audit

Approved main was fetched and verified exactly at c68b12200a36bd3e45f94292047dc03538908a29 before implementation. Branch: codex/phase-5-production-readiness. Prior migrations are immutable.

The local baseline attempted migrate deploy, seed, typecheck, lint, the full suite and build. Typecheck passed. Windows restricted-process execution blocked Prisma/esbuild subprocesses; PostgreSQL recovery also failed checkpoint signaling. The baseline full suite could not establish database/browser results. Build compiled then failed worker rendering. Lint traversed old generated .next-browser-* directories; Phase 5 excludes only those generated outputs, not source/tests. These are not baseline passes. Clean Linux verification of the exact baseline is required before completion.

Subsequent clean Linux CI verified the exact approved baseline successfully in workflow run 35568823230 (baseline job 106235928472), including migrations, seed, typecheck, lint, tests and production build. This resolves the baseline execution blocker; the local attempts above remain recorded as failures rather than retroactively counted as passes.

## Existing controls and required additions

- Financial operations use durable immutable intents, provider receipts, reservation/host guards, fenced claims and recovery. Payouts require accounting completeness and all-generation bank-movement classification. These invariants must remain intact; launch gates are additional admission controls, never replacements.
- Email codes have PostgreSQL-serialized issuance and atomic, bounded, purpose-bound consumption. Auth.js JWT cookies refresh current active user/role, but lack persistent device-session revocation and idle expiry.
- Private files use Cloudinary authenticated assets or local disk. Existing identity, business, collaboration, condition-photo and finance routes authorize reads; shared S3 integrity/lifecycle controls and uniform durable deletion are missing.
- ClamAV INSTREAM already fails closed on malformed/unavailable replies. Upload scans are synchronous; durable scan lifecycle, version records and recovery are missing. Owner exceptions must never permit infected downloads.
- Auth and marketplace throttles use PostgreSQL. Broader route throttles, strict origin enforcement, CSP and request observability need shared controls.
- Existing proxy covers account/admin pages, with route/service-level authorization elsewhere. It is not an API authorization boundary.
- Existing permanent redirects emit 308; requested 301 must be explicit. Secure deployment environment must be distinct from NODE_ENV.
- Finance provider requires sandbox opt-in and test keys. Rental Stripe client can currently instantiate live keys; Phase 5 must explicitly prevent live money movement.

## Providers and data

PostgreSQL (btree_gist and direct session/advisory locks), Stripe payments/Connect/webhooks, Resend email, Cloudinary vehicle photos/legacy private files, optional Twilio signed consent/SMS, private ClamAV TCP. Add S3-compatible private object storage and authenticated sanitized alert delivery. Separate resources and credentials are required for preview, staging and production; a configuration declaration alone cannot prove resource isolation.

Sensitive data includes identity images and hashes, contact/address data, host ownership/insurance files, condition/claim photos, agreements, finance PDFs, auth codes, session credentials and provider payloads. No raw payload, filename, address, code or secret may enter telemetry.

## Worker inventory

- /api/cron/expire-holds: expired checkout holds.
- /api/cron/financial/[worker]: Stripe event, rental/deposit/refund recovery, reconciliation, release, outbox and financial settlement workers (authoritative names in financialWorkers).
- /api/cron/payouts/[worker]: accounting, recovery, schedule, reconciliation, historical-audit.
- /api/cron/community: transactional notices, channel delivery and collaboration retention/deletion.
- Missing uniform operational observation, scanner recovery, broader private-file retention, deadline escalation and stale-worker alerts are Phase 5 scope.

See the generated route/environment inventory for every existing API route and variable identifier. Final documentation must distinguish configuration checks, controlled-provider tests, actual operational tests and unverified live-provider gates.
