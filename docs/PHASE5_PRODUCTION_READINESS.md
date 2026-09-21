# Phase 5 staging foundation and release boundaries

Branch: `codex/phase-5-production-readiness`. Approved baseline: `c68b12200a36bd3e45f94292047dc03538908a29`. This implementation prepares isolated staging; it does not approve production or enable live money movement.

Implemented controls include typed deployment validation, persistent device sessions and reauthentication, release/policy gates, shared request controls, private S3 manifests and durable operations, TLS scanner integration, operator observability and recovery routes. National jurisdiction gates default every state to DISABLED and permit only explicitly configured STAGING. Marketplace pricing freezes policy identity, configuration, input facts and calculation; sample fees remain unsettled, while taxes, protection, deposits and host balances remain liabilities.

## Additive migration inventory

| Migration | Purpose |
| --- | --- |
| 20260928010000_production_controls | Sessions, private manifests, operational jobs, release/policy registry |
| 20260928020000_security_evidence_fencing | Immutable private evidence and review metadata |
| 20260928030000_national_jurisdiction_pricing | Disabled jurisdictions, independent approvals, versioned pricing and subscriptions |
| 20260928040000_jurisdiction_authority_fencing | Admission/configuration locks and immutable reservation jurisdiction |
| 20260928050000_private_write_receipts | Persist uncertain/stored provider write state; conservative historical classification |
| 20260928060000_release_policy_fencing | Serialize release/policy/document changes with protected dispatch |
| 20260928070000_retention_schedule_fencing | Fence exact retention-schedule changes against deletion authorization |
| 20260928080000_agreement_artifact_intent | Persist immutable PDF bytes before storage, recover missing agreement artifacts |
| 20260928090000_operational_alert_payload | Freeze alert request bodies across uncertain delivery retries |

No approved Phase 1–4 migration is rewritten. Historical nullable jurisdiction fields are deliberately not guessed from free-form addresses. Legacy inventory must be verified before admission. New pricing policies cannot recalculate old reservations.

## Verification record

The exact approved baseline passed [clean Linux CI, run 35568823230](https://github.com/hemanthvuddagiri13-oss/Rent-a-4-wheel/actions/runs/35568823230). Local Windows process restrictions prevented a trustworthy baseline full run; those attempts are not counted as passes. Historical-schema migration queries preserve their original assertions while querying columns that exist at each historical boundary. Browser role tests use separate contexts so an earlier page cannot overwrite another test's session cookie.

The release acceptance gate is the complete `Financial verification` workflow at the exact PR HEAD: fresh migrations, seed/generated client, typecheck, lint, production build, client-secret checks, two HTTPS production-build staging runs, two full suites (including populated upgrades), dependency/credential/migration-integrity checks, and five repetitions of each critical race group. The three staging tests are intentionally skipped in ordinary full-suite runs and executed explicitly against the production build; skipped tests are not reported as staging passes. The PR's final report must identify the exact commit and successful run, not substitute an earlier checkpoint.

Recorded intermediate evidence: commit `49ef1d259a797f7767467ae7ef5f56212e2e24fa` passed both full suites (474 passed, three staging tests intentionally skipped in each), national/security and dispatch repetitions, and build in [run 35579488018](https://github.com/hemanthvuddagiri13-oss/Rent-a-4-wheel/actions/runs/35579488018); that run then failed an ambiguous staging locator and is not an acceptance pass. After making the device locator exact, commit `e47edd41963214a3d837171b4e86ec584b78f76a` passed all three production-build staging tests twice in [run 35581272309](https://github.com/hemanthvuddagiri13-oss/Rent-a-4-wheel/actions/runs/35581272309). Final acceptance still requires the complete workflow on the PR's final commit, including these documentation changes.

Targeted tests cover actual PostgreSQL session revocation/suspension, simultaneous worker claims/stale leases, jurisdiction disable/revocation lock contention, frozen pricing and balanced partial-refund liabilities. Real AWS SDK and ClamAV protocol clients run against clearly identified controlled provider fixtures for quarantine, immutable writes, upload/delete races and deletion recovery. These do not establish real AWS, ClamAV or Stripe readiness.

Additional coverage includes immutable agreement-byte recovery after a projection crash; retention-approval revocation during deletion authorization; exact-content legal approvals; exclusive alert claims and frozen retry payloads; guarded legacy-document import; logout-cookie replay; invalid session rotation; cron authentication; sanitized readiness; and complete executable scheduler inventory. HTTPS browser fixtures use a disposable certificate and PostgreSQL TLS, a real Next.js production server and real database sessions. Unavailable external endpoints deliberately prove fail-closed readiness rather than successful provider integration.

An actual disposable PostgreSQL logical restore matched 100 public tables and 1,442 synthetic rows by ordered content digest. Details and limitations are in DEPLOYMENT.md. No production backup or PITR success is claimed.

Changes are grouped in the PR diff: nine additive migrations and Prisma models; environment/release/session/request controls; private storage/scanning/operational recovery; jurisdiction/pricing/ledger integration; account/operator/checkout/statement presentation; provider/database/browser tests; CI and executable schedules; deployment, security, incident and release documentation. PHASE5_INVENTORY.md lists the route, provider and data boundaries. Existing approved migration files remain unchanged.

## Production remains blocked

All production money movement and production jurisdiction approval remain unavailable. Real infrastructure isolation, TLS/IAM/signatures, provider test-mode journeys, backup restoration, scheduling/alerts, load/security review and professional jurisdiction approvals require separate evidence. Sample pricing cannot be promoted to approved by changing its label. Final fee recognition, risk-reserve release and recurring subscription billing need separate reviewed implementations.

Read DEPLOYMENT.md, OPERATIONS_RUNBOOK.md, SECURITY.md, INCIDENT_RESPONSE.md, RELEASE_CHECKLIST.md and NATIONAL_ARCHITECTURE.md together. The final report must supply exact commit/CI evidence and explicitly retain these unresolved production blockers.
