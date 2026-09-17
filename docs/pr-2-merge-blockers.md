# PR #2 correction: financial review and revoked business-file access

Scope: the two confirmed blockers at `256736c5a92fe40384a9b16d259227bf318dbbf2` and matching shared authorization/transition paths.

## Return completion

Under the existing reservation/vehicle lock, completion reads current disposition, FinancialCase and PaymentReconciliation records, payments, refunds, deposit and financial operations. It rejects unresolved cases (including VERIFIED-but-not-resolved cases), open/manual reconciliations, pending/legacy-uncertain refunds, uncertain or leased operations, missing rental settlement evidence, missing required deposit records, and dispositions other than OPEN or TERMINATED. A POLL operation is only settled enough when it has a bound provider identity and a known successful rental or capturable deposit result.

Completion preserves the current disposition; it cannot clear REVIEW. The shared transition enforces this for host, administrative and emergency completion. Cancellation also cannot overwrite unresolved review. Rejected completion changes no trip/reservation terminal state and creates no release intent or provider call. Existing inspection evidence stays saved.

The existing super-admin AUTHORIZE_SETTLEMENT case action now supports a no-additional-charge return after provider verification and all other uncertainty is resolved. It records TERMINATED and resolves the verified case atomically, without completing the trip or planning a release. The host retries normal completion, which rechecks everything and preserves that approved disposition. There is no force flag.

A release queued before later return reconciliation is revalidated before provider retrieval and again under the pinned provider-dispatch guard. Phase 1 compensation for exact superseded/expired pre-trip authorizations remains governed by its existing policy; the new return-release guard does not disable that recovery.

## Business-file policy

Marketplace business files and host agreement PDFs share `canReadBusinessFile`. Every read queries current active user authority and the owning tenant. Access requires the current host owner, an active/unexpired MANAGER membership, or a current ADMIN/SUPER_ADMIN where scan policy permits. STAFF membership, removed/disabled/expired membership, inactive user, suspended host and unrelated tenant are denied. Uploader identity never grants authority; only after current authorization passes may the uploader view its development-quarantined upload. Administrators require a clean file.

Denied reads return the same metadata-free 404 as an unknown file before storage reads or signed-URL generation. Successful private reads retain existing audit entries. The existing audit policy records successful reads, not denied attempts.

Migration `20260923010000_employee_access_lifecycle` adds active/expiry membership fields; existing memberships remain active with no expiry. Both shared host-context resolvers use the same current-membership predicate; neither caches authority.

## Regression evidence

`return-financial-review.test.ts` uses the real reconciliation and resolution services, separate PostgreSQL connections, explicit barriers and observed distinct blocked backends. Both reconciliation-first and completion-first orderings are exercised, plus reconciliation during provider retrieval, unresolved evidence without a disposition flag, and staff/emergency transition protection. Provider cancellation is counted and must remain zero when authority is blocked.

`business-file-revocation.test.ts` calls actual upload/GET handlers with real membership/role/active/expiry changes. It reuses the session and file ID, tests remove/re-add with changed permissions, tenant/owner/admin access, and counts real storage-entry and signed-URL calls. Only session and external storage/scanner boundaries are controlled; membership is not mocked.

CI runs fresh/populated migrations, seed, typecheck, lint, both complete suites, production build, existing financial stability checks, and both new integration suites five times. Production gates remain attorney-approved legal terms, deployed malware scanning, Stripe end-to-end verification, monitored worker schedules and durable private storage.
