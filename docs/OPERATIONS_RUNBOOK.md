# Operations runbook

Monitoring counts overdue or never-successful schedules from persisted CRON_COMPLETE events using `WORKER_STALENESS_MINUTES`. A stopped monitor cannot report its own outage: the external scheduler must alert on missed monitor invocations and failed HTTP responses. Alert bodies and idempotency keys are persisted together; retries do not substitute current metrics into an older request. Missing historical alert payloads require review.

Schedule `/api/cron/operations/agreements` every two minutes with the same bearer authentication as other operations jobs. It recovers missing signed PDFs using frozen acceptance evidence, persisted exact bytes and a fixed storage identity. Uncertain storage writes enter review; signing again is not recovery. Existing attached PDFs are never regenerated.

New deployed retention erasure requires an independent effective PRIVACY_RETENTION jurisdiction gate and a professional RETENTION approval whose hash matches `fingerprint(policy(tx))` for the configured collaboration schedule. Sample defaults authorize no erasure. Unknown geography and unscoped records remain for review. Admission disablement does not revoke an independent erasure approval, and already committed deletion intents continue recovery. All financial, agreement, claim and legal/security holds remain mandatory. No jurisdiction has production retention approval in this phase.

Every route below requires the cron bearer secret. POST is preferred; GET aliases support schedulers. Use the persistent Node deployment and direct database session connection. Jobs process bounded batches, so schedule recurrence and independently alert on scheduler silence.

| Route | Initial cadence | Purpose |
|---|---|---|
| `/api/cron/expire-holds` | 1 minute | Expire transient holds; preserve compensation intent |
| `/api/cron/financial/stripe-events` | 1 minute | Claimed/fenced Stripe event recovery |
| `/api/cron/financial/reconciliation` | 2 minutes | Rental/refund provider reconciliation |
| `/api/cron/financial/refunds` | 1 minute | Resume immutable refunds |
| `/api/cron/financial/deposits` | 1 minute | Authorization expiry/release recovery |
| `/api/cron/financial/outbox` | 1 minute | Claimed durable email delivery |
| `/api/cron/financial/historical-audit` | 15 minutes | Quarantine legacy uncertainty |
| `/api/cron/payouts/accounting` | 1 minute | Journals, earnings and accounting checkpoints |
| `/api/cron/payouts/recovery` | 1 minute | Test-mode provider movement recovery |
| `/api/cron/payouts/reconciliation` | 2 minutes | Test-mode transfer/payout reconciliation |
| `/api/cron/payouts/schedule` | 5 minutes | Eligible test-mode batch planning |
| `/api/cron/payouts/historical-audit` | 15 minutes | Legacy finance audit |
| `/api/cron/community` | 1 minute | Notices, consented channels and bounded retention |
| `/api/cron/operations/scan` | 1 minute | Quarantine scanning and scanner evidence |
| `/api/cron/operations/delete` | 1 minute | Authorized exact-key deletion recovery |
| `/api/cron/operations/monitor` | 5 minutes | Backlogs and overdue-case escalation |

Cadences are operational starting points, not legal deadlines or capacity guarantees. Measure queue age/duration under representative load. Preserve exclusive claims, immutable keys and fencing when scaling. Operations use SKIP LOCKED, leases, bounded retry and explicit review on exhaustion. Alert receivers must honor Idempotency-Key; external exactly-once delivery is not assumed.

## Triage and kill switches

SUPER_ADMIN `/admin/operations` shows sanitized configuration, backlog counts, flags, state modes and approvals. Financial differences belong in finance reconciliation/case workflows. Never repair balances by editing journals, provider keys, refund amounts or object ownership. Verify provider account/environment before inspecting outcomes.

Operational events contain category, severity, generated request ID, source worker, duration and count. Investigate failed workers, uncertain money, failed refunds, release backlog, payout holds, outbox failures, scan/deletion failures, overdue cases and uncertain writes. Monitor health and worker silence externally; the app cannot report its complete outage.

Feature/state changes require a fresh security code and audit reason. The release fence waits for already-dispatched bounded calls, then blocks new effects. Refunds, reversals, releases, returns and existing cases keep separate authority. Do not stop recovery workers as a substitute for stopping new money.

## Private files

Quarantined, infected, failed and uncertain-write objects are unreadable. Deployed reads require current application authorization, clean manifest and matching hash/size. Clients receive no S3 URLs. Legacy Cloudinary links expire after 60 seconds and are server-internal only. Application file URLs are private/no-store and require current authorization on every request.

Infection is terminal: never relabel it clean. Restore scanner TLS/connectivity/signatures before reauthenticated, reasoned retry of failed jobs. A fresh claim/fence is mandatory. Never copy identity images into development to diagnose failures.

Deletion first commits logical revocation and durable intent. Holds are checked before this point; later holds cannot resurrect an in-flight deletion. Provider errors remain pending/review. Exact-key S3 version erasure is bounded; an excessive version count requires reviewed recovery.

`writeState=RUNNING/UNCERTAIN` means upload completion is unproved. Lost responses do not prove absence. No second write or successful erasure claim is permitted. Obtain provider request/object evidence and resolve under a reviewed procedure; do not simply reset state or delete the manifest. Automated ambiguous-upload adjudication is intentionally unavailable. Exercise this procedure with the real provider before release.

Legacy files without manifests stay unreadable in deployed environments until a reviewed import establishes provenance, hash/size, retention and scan evidence. SUPER_ADMIN may submit `action: importLegacyObject` to `/api/admin/operations` with a fresh security code, reason, known resource type/id, expected SHA-256, size and MIME type. Supported types are IDENTITY, BUSINESS, CONDITION, AGREEMENT and COLLABORATION. The server resolves the existing storage key; arbitrary keys/URLs are not accepted. Existing source hashes must match. Objects without historical hashes require independently verified provider inventory evidence. The import records a durable intent, verifies bytes, leaves a retention hold and queues a new scan. It cannot override an existing upload's uncertain outcome, infection or deletion intent. A failed read can be retried through the same import command with fresh reauthentication. Import is not proof of Cloudinary encryption or production provider approval.

Never manufacture clean status from an unverified URL. Financial and signed-agreement evidence has no automatic destruction approval. Privacy outcomes may require retention/legal review, not promises of complete erasure.

## Outage recovery

Verify database connectivity/session locks first. Reconcile provider evidence and accounting, then run refunds, deposits and event replay. Keep admissions/payouts disabled until uncertainty, ownership conflicts and accounting differences are resolved. Recheck notification authorization before delivery. Record the timeline without sensitive payloads in general logs.
