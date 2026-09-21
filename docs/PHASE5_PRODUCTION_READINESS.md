# Phase 5 implementation status

Branch: `codex/phase-5-production-readiness`. Approved baseline: `c68b12200a36bd3e45f94292047dc03538908a29`. This is an in-progress verification record, not a completion or production approval.

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

The exact approved baseline passed clean Linux CI in run 35568823230. Local Windows restrictions prevented a trustworthy baseline full run; those attempts are not counted as passes. Subsequent CI exposed fixture and historical-schema query assumptions, which are being corrected without deleting original assertions. The final commit still requires two complete passing suites, repeated races, build and browser evidence.

Targeted tests cover actual PostgreSQL session revocation/suspension, simultaneous worker claims/stale leases, jurisdiction disable/revocation lock contention, frozen pricing and balanced partial-refund liabilities. Real AWS SDK and ClamAV protocol clients run against clearly identified controlled provider fixtures for quarantine, immutable writes, upload/delete races and deletion recovery. These do not establish real AWS, ClamAV or Stripe readiness.

## Production remains blocked

All production money movement and production jurisdiction approval remain unavailable. Real infrastructure isolation, TLS/IAM/signatures, provider test-mode journeys, backup restoration, scheduling/alerts, load/security review and professional jurisdiction approvals require separate evidence. Sample pricing cannot be promoted to approved by changing its label. Final fee recognition, risk-reserve release and recurring subscription billing need separate reviewed implementations.

Read DEPLOYMENT.md, OPERATIONS_RUNBOOK.md, SECURITY.md, INCIDENT_RESPONSE.md, RELEASE_CHECKLIST.md and NATIONAL_ARCHITECTURE.md together. The final report must replace this in-progress verification section with exact commit/CI evidence and explicitly retain unresolved blockers.
