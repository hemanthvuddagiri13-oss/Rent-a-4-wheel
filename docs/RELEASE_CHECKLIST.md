# Staging-to-production checklist

Unchecked items are blockers, not implied approvals. No state or pricing policy is production-approved in this implementation. A production launch requires a separately reviewed implementation enabling an approved mode; changing an environment variable or feature flag cannot accomplish it.

## Code evidence at the release commit

- [ ] Approved migration hashes unchanged; additive migrations reviewed against fresh and populated databases.
- [ ] Seed, generated client, typecheck, lint, two complete suites, repeated financial/security races and production build pass at the same commit.
- [ ] Real Next.js/PostgreSQL browser journeys pass, including staging configuration, revocation, private access, origins and security headers.
- [ ] Dependency audit and credential/client-artifact checks pass; findings have explicit dispositions.
- [ ] Review exact branch/commit and attach CI/artifacts. Do not substitute an earlier passing commit.

## Isolated staging operations

- [ ] Verify separate database, bucket, KMS key, email sender, Stripe test account/webhook, scanner and monitoring resources. Test cross-environment access denial.
- [ ] Verify runtime/direct database TLS, btree_gist, session locks, timeouts, connection limits and real concurrency under load.
- [ ] Verify S3 private policy/encryption/version deletion and scanner signatures using real services. Controlled fixtures are not this evidence.
- [ ] Exercise scheduled workers, lease takeover, bounded retries, dead-letter review, alert delivery and on-call acknowledgement.
- [ ] Complete real Stripe test-mode browser payment, deposit action/retry/expiry, refund, cancellation, Connect and payout recovery scenarios without live keys.
- [ ] Exercise backup/PITR restoration into isolation and record measured RPO/RTO and reconciliation. Migration tests do not prove recovery.
- [ ] Verify DNS, HTTPS, permanent redirects, secure cookies, ingress header replacement, firewall and body limits.
- [ ] Verify Resend domain, SPF/DKIM/DMARC and delivery/bounce behavior. Verify SMS consent and signed callbacks before enabling SMS.
- [ ] Inventory legacy private objects and unresolved uploads; prove authorized reads, quarantine, retention holds and actual erasure workflows.

## Production approval (not supplied by this PR)

- [ ] Independent versioned entity, legal, insurance, tax, privacy/retention, operations, payments, host payouts, local/airport, host, guest and vehicle approvals for each jurisdiction.
- [ ] Real cost model for insurance, claims, processing, tax, fraud and support; approve all fee caps, promotions, subscriptions, volume tiers and allocations.
- [ ] Approve policy content and retention schedules with the relevant professionals. No sample legal text or configuration counts as evidence.
- [ ] Implement/review production jurisdiction mode, final fee recognition, reserve release and any recurring subscription collection. Preserve historical snapshots and liabilities.
- [ ] Perform independent security/load review and an incident exercise; resolve merge-blocking access, evidence or financial failures.
- [ ] Record authorized launch decision and staged rollout/rollback criteria. Live finance remains disabled until a separate reviewed release.
