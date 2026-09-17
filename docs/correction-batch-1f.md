# Correction Batch 1F

This batch changes only legacy rental evidence linking, ownership-blocked deposit
release quarantine/counting, and their regression tests. No migration is needed:
case links are populated only after operator-supplied provider evidence is verified
under the reservation lock. Previous migrations are unchanged.

## Legacy reservation review

For `LEGACY_RESERVATION_REVIEW`, the supplied Stripe identity must identify exactly
one existing RENTAL Payment and one existing RENTAL FinancialOperation. Canonical
provider ownership, when present, must agree on kind, reservation and owner IDs.
Customer, reservation metadata, automatic capture, non-deposit purpose, amount,
currency, payment metadata and available original operation lineage must agree.
Successful local payments require successful provider evidence. Conflicting or
missing matches roll back without modifying the case or financial records.

Verified evidence fills the existing case's payment, operation, provider and
original-key links and uses the Payment's amount/currency. Ordinary adoption then
validates the immutable payload and lease and records the evidence in its audit
event. It creates no replacement rental operation or second provider owner.
Verification leaves the reservation quarantined. Settlement still requires a
separate super administrator action; inventory stays reserved until durable refund
completion or an authorized inventory-release action.

## Deposit release quarantine

Every executable release is checked against its immutable target and canonical
deposit ownership before Stripe retrieval/cancellation. Missing, BLOCKED,
cross-kind or ambiguous ownership moves that specific release to REVIEW under the
reservation lock, clears its lease and retry timestamp, and creates/updates the
unique `operation:<id>` reconciliation case with generation and known evidence.
The audit event preserves the prior state/error/case reason. Repeated recovery
does not duplicate cases or quarantine audit events. Quarantined states are
excluded by the due query before its 25-item limit. Legacy authorization adoption
also skips ownership-blocked identities so it cannot abort the release batch.

The deposit worker returns `releases: { processed, failed, quarantined }` and
`deposits: { processed, pending }`. Top-level processed sums completed release and
deposit work, pending/failed include retryable errors, and quarantined counts
release attempts requiring operator review. Quarantine is not provider success.

## Tests

- The populated migration test creates the generic case using the actual Batch
  1D migration, applies Batch 1E, then invokes the real case service and refund
  executor against PostgreSQL. Only Stripe is replaced by controlled responses.
  It checks EUR authority, mismatches, ambiguous operation lineage, preserved
  audit/ownership, no duplicate rental operation and settlement before inventory
  release.
- The real worker quarantines 25 blocked releases, then cancels the later valid
  target on its second invocation, with exact release counts and no blocked
  provider calls.
- The substitution regression starts with an unbound rental Payment and asserts
  the exact purpose/capture rejection and unchanged records. The unbound valid
  rental positive control successfully adopts.

The complete CI workflow runs fresh and populated migrations, seed, typecheck,
lint, all tests twice and a production build. Live Stripe/SCA verification,
deployment/cron validation and existing document-scanning/legal production gates
remain separate.
