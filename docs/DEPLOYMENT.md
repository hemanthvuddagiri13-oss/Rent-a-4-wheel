# Deployment

Use a persistent Node.js 24 container/service behind a trusted TLS ingress and PostgreSQL 17. Financial and storage dispatch pin physical database sessions across bounded provider calls. `DATABASE_URL` may use a compatible runtime pool; `DIRECT_DATABASE_URL` must bypass transaction-mode pooling. Migrations and backups use the direct endpoint. An edge-only runtime or transaction-pool-only database is not an approved topology.

This PR does not deploy production. Preview, staging and production require separate databases, buckets, encryption keys, provider accounts/webhooks, sender domains, secrets and schedules. Labels are configuration inputs, not proof of isolation. Verify actual resource identities and deny cross-environment IAM/database access.

## Configuration

Copy `.env.example` only for local development. Deployed environments require `APP_ENV`, matching HTTPS site/domain/URL aliases, runtime and direct database URLs, distinct high-entropy auth/cron/monitoring secrets, complete Stripe test configuration, Resend, private S3, TLS ClamAV and monitoring. Prisma 6 TLS uses `sslmode=require&sslaccept=strict`; use `sslcert` for a private CA. Validate against the real server, not merely the URL syntax.

S3 requires the full KMS key ARN, all four public-access blocks, a non-public policy and default KMS encryption. Grant only bucket/object/version/encryption inspection and exact-key read/write/delete permissions used by `s3-private.ts`. Enable versioning and access audits. Never serve private objects or credentials publicly. The deletion worker removes exact-key versions, not only delete markers.

Run current ClamAV signatures behind a restricted TLS endpoint whose certificate matches `CLAMAV_HOST`. INSTREAM itself provides no user authentication; restrict peers using application/network identity. The application verifies TLS and records engine/signature versions. Missing, partial, oversized, infected or unavailable scans remain unreadable. Antivirus is not proof that content is safe.

Ingress must replace `x-real-ip`, strip caller-supplied forwarding headers and prevent direct access to the origin. PostgreSQL backs shared rate limits. Configure ingress body/time limits and protect health endpoints from abuse. Deploy using secret-manager injection; never embed secrets in images or public environment variables.

## Domains

Production canonical domain: `renta4wheel.com`. Provision DNS, certificates and ingress for it, `www.renta4wheel.com`, `rentafourwheel.com` and `www.rentafourwheel.com`. Alternate hosts must return HTTP 301 to the canonical domain, preserving path/query. Application redirects are in `next.config.ts`; verify the real ingress independently. This PR does not change DNS or issue certificates.

Staging uses a separate hostname, cookies and callbacks, restricted ingress and no indexing. Deployed sessions use secure HTTP-only same-site cookies with database revocation. Preview must never share production data/providers. Live charges and payouts remain unavailable even with feature flags enabled.

## Release sequence

1. Provision isolated infrastructure and secrets; verify TLS, IAM, backup retention and provider test mode.
2. Run `npm ci` and the complete verification matrix at the proposed commit. Preserve approved migrations.
3. Verify a pre-upgrade backup. Run `prisma migrate deploy` through the direct endpoint; never migrate-dev/reset deployed data.
4. Seed only the intended environment. Seed does not approve a state or production money. Verify demo listings remain hidden.
5. Deploy the built application. `/api/health/live` is liveness; `/api/health/ready` returns only a boolean after configuration, database extension/session-lock, bucket and scanner checks.
6. Configure every job in the operations runbook. Pass the cron bearer secret in a header, never a query string.
7. Inspect the SUPER_ADMIN operations page, failed jobs, flags, state modes and registry. Staging requires explicit reviewed evidence; no state is production-approved.
8. Complete real staging browser/provider, load, restore and alert exercises. Record evidence and blockers in the release checklist.

Rollback uses a prior image only after schema compatibility review. Never roll back additive financial migrations or erase journals. Migration failure or suspected loss of financial evidence stops admissions pending investigation.

## Backups

Require encrypted managed PostgreSQL backups and PITR/WAL retention sized by approved RPO/RTO. Protect backup access separately. An isolated restore must verify reservations, provider intents/receipts, ownership, refunds, journals, snapshots, payouts, sessions, files and migration history. Compare balances and unresolved-operation counts before reopening admissions. Revoke restored sessions and leave dispatch disabled until reconciliation completes.

Fresh/populated migration tests are not production backup/PITR evidence. No production restore, capacity limit, RPO/RTO or real infrastructure isolation is claimed by this PR.

### Disposable restore exercise, 2026-09-21

PostgreSQL 17 `pg_dump -Fc` backed up the synthetic local test database after the nine additive Phase 5 migrations. `createdb` created a separate `phase5_restore_20260921` database, and `pg_restore --exit-on-error` restored it without dropping or changing the source. All 100 public tables and 1,442 rows matched the source by count and ordered row-content digest. `btree_gist` was present. The existing `payout_available_funds_nonnegative` NOT VALID constraint remained in the same state as the source; this exercise did not rewrite or validate historical financial constraints.

This proves a logical dump/restore of disposable test data only. It does not prove managed backups, WAL/PITR, production-volume recovery, RPO/RTO or external-provider reconciliation. The dump is outside the repository and is not a deployable artifact.

To repeat in isolated infrastructure: stop test writers, record source table counts/content digests, create a custom-format dump through the direct connection, restore with `--exit-on-error` into a newly created empty database, and compare every table plus extensions/constraints and migration history. Never restore into the live database for this exercise. Disable dispatch and revoke restored sessions before exposing any restored application; reconcile external provider state before considering admissions.
