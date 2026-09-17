# PR #3 correction policy

## Reservation evidence retention

`reservation-retention.ts` owns the single SQL predicate used both before a
worker's batch limit and again under the shared financial reservation lock.
The underlying order is vehicle guard/row, reservation, child record, deletion
operation. Review, case, conversation and file hold writers use this order;
privacy preservation locks all affected reservations in vehicle/id order.
The repeated-webhook-failure reconciliation writer now uses it too.

Preservation includes financial REVIEW, every financial operation (including
uncertain/quarantined attempts), unresolved financial cases/reconciliations,
payment/refund/deposit evidence, signed agreements, any open case or unexpired
case retention period, case legal/security holds, conversation/review/file
legal holds, and an applicable RETAINED_LEGAL_REVIEW privacy request. In the
current schema, reservation legal/security preservation is recorded through
these linked records; there are no separate Reservation legalHold fields.
Ordinary privacy deletion requests never authorize erasure of protected evidence.

The predicate covers review expiration, message/history purging, case content
and incident/support evidence, private attachment intent and deletion, and
reservation-linked notification delivery metadata. Unknown notification
provenance is conservatively retained. Held rows are filtered before LIMIT;
the locked recheck handles holds committed after candidate selection. The next
cron run rechecks text candidates; blocked storage jobs retry no sooner than a
day later. No increased batch size is used to conceal starvation.

Under a hold, review body, rating, categories, author and moderation history,
and audit records remain unchanged. Once eligible, public review body/categories
are cleared and the review is hidden exactly once. ReviewHistory is no longer
deleted: author snapshots, moderation actions/reasons, timestamps and actor IDs
remain protected audit evidence, along with the scalar review rating and IDs.
This is public-content expiration, not complete anonymization or certified
privacy erasure. There is no automatic legal release of financial, agreement or
review audit evidence. A future approved audit-retention policy is needed before
erasing it. A later hold cannot undo a previously committed storage deletion;
review audit snapshots, unlike storage bytes, remain available after public
expiration. Lock order determines which operation was authorized first.

## Independent case decisions

Assignment, ordinary operator transitions, emergency decisions and safety
clearance share `independentCaseActor`. Under reservation/case locks it locks
and re-reads the current active account and role, and rejects:

- the reservation customer, case opener or recorded party/appeal participant;
- the host owner, the titled owner's host-account owner, or the account whose
  normalized email matches the titled-owner contact;
- anyone ever recorded as employed by that host, including inactive, expired
  or deleted memberships;
- any evidence uploader on a case for the reservation or original condition
  report submitter. Linking someone else's existing photo alone is not treated
  as authorship.

The additive HostAffiliationHistory migration backfills existing memberships
and records future inserts/updates. Revoking/deleting a membership cannot erase
the conflict. The policy conservatively treats all recorded past affiliations
as relevant; it does not attempt to infer a safe historical cutoff. Previously
deleted relationships unavailable in the old database cannot be reconstructed
by this migration and need operational review before production assignment.

An override requires SUPER_ADMIN plus assignment to the actor. Initial
assignment cannot silently replace another agent. A separate versioned takeover
requires an independent SUPER_ADMIN and a reason of at least ten characters,
retains the old/new assignee and reason in AuditLog, appends a TAKEOVER event,
and atomically queues an inbox notice/email for the previous agent. The actor
must then submit an override using the new version and a fresh purpose-specific
code. Takeover itself does not decide the case. Terminal decisions cannot be
reopened by either command. Financial REVIEW and separate money authorization
remain intact.

Conflicts, stale versions and assignment failures are rejected before consuming
codes. Authorized verification uses the existing atomic, attempt-limited,
single-use EMERGENCY_OVERRIDE_STEP_UP verifier. Its consumption commits
independently; a subsequent case transaction failure requires a fresh code.
Neither failed guesses nor successfully consumed codes roll back with the case.
Only a committed decision creates the successful override audit entry.

The community HTTP route and case UI use this service. The separate legacy trip
override does not change ServiceCase decisions and still enters financial
trip-start/return authority checks; it is not an alternate case-decision path.

## Verification

`tests/community-blockers.test.ts` executes the actual retention worker and
case service/HTTP handler against PostgreSQL; only HTTP session identity is
supplied at the authentication boundary. Race tests hold real transaction locks,
observe distinct waiting backend PIDs via pg_stat_activity, and release explicit
barriers. They cover financial/claim/hold writers versus retention, and ordinary
decisions versus takeover. The starvation fixture has 102 held expired reviews
before an eligible review. Existing community tests are retained and the old
override test now performs the required initial assignment.

The populated migration test also verifies affiliation backfill survives
membership deletion. CI runs fresh migrations, seed, typecheck, lint, the full
suite twice, production build, and the blocker suite five times, in addition to
the existing financial and community stability suites.
