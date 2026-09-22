# Phase 5 correction batch

Branch: `codex/phase-5-production-readiness`; rejected source: `f0255dc67c3af670c60df9d3238695e5f4d573fb`.
This document records implementation evidence, not production approval. Live money stays disabled.

## Reproductions before the corresponding fixes

- Refund/adjustment regression: accounting certification becomes incomplete immediately after a host debit, despite balanced previously posted refunds.
- Processing settlement: all three funding modes leave a 300-cent processing payable outstanding.
- Inquiry route: disabled, expired, revoked and missing jurisdiction authority return HTTP 200 and create a conversation.
- Hosting: the approval route approves a submitted host and the availability command enables bookings after the hosting flag closes.
- Confirmation: both required-deposit and no-deposit reservations retain OPEN financial disposition after booking authority closes.
- Legal edit versus signing: separate PostgreSQL connections and an observed lock wait reproduce SQLSTATE `40P01` (document row versus release advisory lock).
- Admin entry points: feature mutation without confirmation, settings without security proof, and legal editing after role revocation all succeed.
- Workers: clock skew rejects a valid lease; a taken-over scan reports completion; an entirely failed authenticated scan cron returns 200 and CRON_COMPLETE.
- Legacy import: non-PNG bytes with a matching supplied hash are accepted as a PNG identity document.

The direct-migration integration test was written before the wrapper. Local Prisma subprocess execution is blocked by Windows `spawn EPERM`; its deployment-path proof must pass in Linux CI. A second disposable local PostgreSQL instance also encountered checkpoint-signaling restrictions after initialization. Neither limitation is evidence of passing migration verification. The populated fixture and its refund recovery were additionally exercised in a disposable historical-schema namespace using the unchanged SQL; that debugging run is explicitly not the required deployment-command proof.

## Corrected boundaries

1. Refund journals retain immutable allocation evidence. Additional refunds consume only their incremental budget and remaining host balance. Credits/debits remain separate journal entries. Certification replays those same allocation rules. Tests include a credit after a realized shortfall, full refunds, replay, and a synchronized adjustment/refund race.
2. Provider fee receipts commit independently of journal projection. Actual fees settle processing accrual and recognize only the variance. Existing incorrect fee journals receive a compensating entry; legacy snapshots retain their original expense classification. Provider availability changes do not alter the original receipt or its monetary fingerprint.
3. Explicit multipart routes permit the documented 8 MB file within a bounded 9 MB envelope. JSON stays at 24 KB. Built HTTP tests exercise conversations, claims, the exact maximum, malformed bytes, oversized requests, and zero provider calls on rejected input.
4. New prebooking inquiries check current jurisdiction authority inside their creation transaction. Existing reservation communications remain available.
5. Shared hosting admission covers onboarding, listing submission, approval, activation, bookability, and legacy vehicle actions. Authority closure/revocation serializes against activation.
6. Both payment-confirmation fences recheck scoped booking/legal authority. Captured payments remain successful; closure creates one durable compensation operation. Separate-connection tests pause immediately before final confirmation and assert one refund and, where required, one deposit cancellation.
7. Readers/writers follow release authority, subject guard/row, legal document, acceptance order. Tests observe blocked PostgreSQL PIDs during real legal editing/signing and policy revocation/signing.
8. Protected mutations require the active SUPER_ADMIN, current device session, a fresh SECURITY_STEP_UP code, explicit confirmation, reason, origin, and bounded input. The mutation and protected immutable audit commit together. Tests include an actual PostgreSQL failure during final audit insertion and session revocation while waiting for authority.
9. Operational leases compare UTC timestamp columns with explicit UTC database time. Only committed fenced completion counts as completed. Scan, agreement, deletion, and alert takeovers expose stale outcomes. Responses include claimed, processed, completed, failed, quarantined, review, and stale counts; entirely failed/stale/review batches signal failure to monitoring.
10. Legacy import authorizes before reading and refuses ambiguous resource aliases. Independent signatures, raster decoding/re-encoding, dimension/pixel bounds, and a bounded passive PDF subset produce immutable validation evidence. Compressed PDF object/cross-reference streams and active constructs remain unsupported and quarantined. Sanitized objects remain held; their retained bytes require the same database encryption, access, backup and approved retention controls as other private evidence. No provider-at-rest or legal-retention certification is inferred from fixtures.
11. The exact upgrade test materializes schema/migrations from `c68b12200a36bd3e45f94292047dc03538908a29`, deploys them, populates historical financial/payout/signed/claim/session evidence, and deploys all nine Phase 5 plus correction migrations. It compares every populated historical table's original columns and exercises pending-refund recovery (one read, zero creates) and completed-refund replay. Phase 4 had no PrivateObject table: the test preserves its real legacy storage references and verifies migration does not fabricate clean manifests.
12. The deployment wrapper selects the direct database endpoint and migration role. Distinct runtime/direct roles and unsafe-topology CLI cases are tested through the real command.

Added migrations: `20260929010000_refund_allocation_evidence`, `20260929020000_provider_fee_evidence`, `20260929030000_protected_admin_audit`, and `20260929040000_private_validation_evidence`. Existing migration files are unchanged.

## Direct migration topology and recovery

Use `npm run db:deploy`, never the runtime connection, for deployed migrations. The wrapper explicitly replaces the child process's DATABASE_URL with DIRECT_DATABASE_URL. Both variables are therefore direct inside Prisma migrate; normal application processes retain their runtime DATABASE_URL. Configure `MIGRATION_CONNECTION_MODE=direct` on deployed migration jobs. Missing direct endpoints, declared transaction/statement pools, known pooler hostnames/ports, and `pgbouncer=true` are refused before starting Prisma. Use a separate migration role owning the schema; runtime roles must not own schema migrations.

The financial provider execution guard uses pinned PostgreSQL sessions and session advisory locks. Runtime financial workers require direct or session-mode pooling. Transaction-mode pooling is not a supported topology for these workers. The migration endpoint must bypass pooling; an operator must verify the actual network topology, including custom hostnames that cannot be inferred from a URI.

On deployment failure, keep admission/live-money flags disabled, inspect `_prisma_migrations` with the direct operator connection, and preserve the failure logs and database backup. Do not alter previously deployed SQL. Correct forward with an additive migration. Use the wrapper's `resolve --rolled-back <migration>` only after proving the failed migration was fully rolled back, or `resolve --applied <migration>` only after verifying every intended statement already committed. Restoring a backup requires an explicit incident plan accounting for provider effects since that backup; it is not an automatic financial rollback.

## Acceptance and production gates

The final report must link a successful CI run at the delivered SHA. CI asserts its checkout, runs fresh deployment migrations, the exact populated upgrade, seed, type generation/typecheck, lint, production build, audit, the full suite twice, every new correction test five times, and existing financial/provider concurrency groups five times. Targeted local tests or a build alone do not complete the batch. The built HTTP tests use controlled loopback providers; the separate staging browser suite checks deployed TLS/configuration behavior.

Live charges remain hard-disabled. Payout/provider writes remain restricted to explicitly enabled Stripe test mode, and production jurisdiction admission is refused. No sample jurisdiction, legal, pricing, insurance, tax or retention evidence is production approval. Production requires independent professional/business approvals, real provider/security configuration, operating-cost validation, verified recovery schedules and monitoring, backups/restores, and provider/browser certification. PR #5 must remain unmerged during this correction task.
