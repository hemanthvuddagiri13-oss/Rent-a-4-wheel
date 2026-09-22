# Accounting outcome correction

Scope: the accounting result boundary and its immediate worker callers. No schema, migration, UI, provider authority or live-finance configuration changes.

## Contract

`accountReservation()` requires the existing reservation lock and returns a typed `AccountingOutcome`:

- `COMMITTED`: complete accounting with newly retained journals or a changed economic checkpoint backed by journals.
- `REVIEW`: payment mismatch, failed historical-refund compatibility, incomplete accounting certification or an unresolved reservation finance issue. This takes precedence even if partial immutable postings were retained.
- `NO_WORK`: no complete economic change, including an idempotent replay or an empty reservation.

Thrown errors retain transaction rollback and are aggregated as failed. The payment-mismatch and compatibility early returns explicitly return REVIEW; the final return examines certification and open holds before considering committed work. Checkpoint version/timestamp refresh alone is not committed work.

`reconcileAccounting()` counts committed, review, failed and skipped separately; legacy processed equals committed. Existing blocked issues remain actionable on replay without retrying their journal writes. Held reservations are distinct and exclude the current batch, preventing duplicate review counts within the accounting result. The shared adapter and authenticated accounting cron preserve these counts: SUCCESS/200, review-only FAILED/503, mixed PARTIAL_FAILURE/503, and NO_WORK/200.

Reconciliation retains nested accounting results. Historical provider audit also observes REVIEW from its accounting projection instead of reporting that observation as successful verification. Other direct callers do not consume the former earning return value; their existing authority checks remain unchanged.

## Regression evidence

`tests/accounting-outcomes.test.ts` uses a fresh PostgreSQL database with every repository migration applied. Dependency wiring selects that real database; accounting, reconciliation, locking, certification, cron and worker adapters are not mocked. A pass-through Prisma query extension counts completed journal create calls. Accounting tests forbid provider construction; the historical-audit caller test permits one controlled read and no mutation.

| Test | Provider calls | Journal creates during exercise | Replay creates |
| --- | ---: | ---: | ---: |
| Persisted amount mismatch | 0 | 0 | 0 |
| Persisted currency mismatch | 0 | 0 | 0 |
| Mixed valid + mismatch | 0 | 1 | 0 |
| Valid, then idle; empty batch | 0 | 1 | 0 |
| Empty reservation direct outcome | 0 | 0 | — |
| Historical compatibility review | 0 | 0 (two immutable fixture journals preexist) | 0 |
| Unauthorized cron | 0 | 0 | — |
| Unmatched refund / incomplete final exit | 0 | 2 partial collection journals; no refund journal | 0 |
| Transaction failure | 0 | 0 | 0 |
| Historical provider audit caller | 1 controlled read; 0 mutations | 0 | — |

Mismatch tests retain the issue, unchanged payment/reservation, payout hold and denied eligibility. Mixed and compatibility tests compare immutable journals across replay. Failure and review remain distinct. The real cron route verifies bearer authentication, HTTP status and the shared result adapter.

The existing socket-level finance HTTP test now seeds an unresolved payment-review issue and requires HTTP 503, actionable counts, unchanged reservation/issue evidence and no journal for that reservation. Its previous unconditional 200 expectation depended on unrelated shared-database fixtures and contradicted the corrected review contract. Isolated completed-work and no-work cases continue to require HTTP 200.

Financial CI runs this suite five consecutive times, the full suite twice, and existing critical financial/concurrency groups five times. Existing candidate CI reruns browser/layout/accessibility/Lighthouse evidence on the correction SHA. Passing results must be read from that exact SHA, not inferred from this document. This correction requires a narrow independent review; it is not an acceptance declaration.

## Durable replay correction

Accounting discovery now selects reservations with succeeded payment, pending/uncertain or succeeded refund,
provider-operation, deposit, fee, dispute, approved-adjustment, earning, journal
or checkpoint evidence, or any unresolved reservation-level FinanceIssue. Provider operations qualify when they have provider/dispatch evidence or are quarantined; deposits qualify when they have a provider ID. Undispatched ordinary checkout intents alone do not freeze accounting early.
Selection uses EXISTS against the reservation primary key: multiple evidence
sources cannot duplicate a reservation. This intentionally re-certifies retained
evidence, including fully journaled no-host bookings and failures that have no
FinanceIssue. The existing reservation lock and immutable journal keys still
protect projection. The oldest checkpoint is considered first within the batch
limit; recertification updates the existing checkpoint rather than inserting
another. Payment mismatches also retain an incomplete checkpoint. Failed projection attempts rotate using the existing accounting-error issue checkedAt field, without clearing its hold; a bounded-batch regression verifies new work is not starved.

All unresolved reservation-level FinanceIssues are holds at the accounting
outcome boundary, so discovery and outstanding-review reporting use no kind
allowlist. This covers ALLOCATION_REQUIRED, ACCOUNTING_INCOMPLETE,
PAYMENT_DIFFERENCE, REFUND_DIFFERENCE, REFUND_COMPATIBILITY_REVIEW,
ACCOUNTING_REVIEW, batch/recovery holds and future review types. A UNION of
unresolved issue reservation IDs and INCOMPLETE checkpoint IDs keeps reviews
outside the bounded batch actionable; selected IDs are excluded from that count.
Actual projection exceptions remain failed, including on retries; they are not
silently reclassified as completed accounting.

The legacy/no-host test asserts one review/actionable outcome, zero committed
and failed outcomes, and HTTP 503 on the initial run and three replays. Its two
journals, one ALLOCATION_REQUIRED issue and one INCOMPLETE checkpoint remain;
checkpoint certification version advances on the same record. Replay creates
no journals or issues and does not change the frozen snapshot or financial
authority. A SUPER_ADMIN cannot close this issue through resolveFinanceIssue.
No authorized resolution or journal rewrite is simulated in this test.

Certification-only evidence is tested without an issue: two review/503 runs,
then an existing payment-failure handler observes a controlled provider decline
and permits recertification. Two subsequent runs produce NO_WORK/200, zero
review/actionable outcomes and no journal writes. The provider boundary is one
read, zero mutations. A mixed batch asserts committed=1, review=1 and HTTP 503.
Two independent PostgreSQL clients, verified by distinct backend PIDs, synchronize
after discovering the same incomplete reservation before either worker projects;
both report review=1 without duplicating journals, issues or checkpoints.

The socket-level finance HTTP suite now owns a separately migrated disposable
database. A never-dispatched provider review produces exactly one review before
authorized step-up resolution and exactly zero afterward. The original issue
and audit record remain; there are no payments, dispatches, payouts or journals.
This existing provider-resolution path does not authorize suspense allocation.

Every marketplace screenshot call supplies its intended h1 text. Every viewport
checks exactly one h1, its expected text and visibility. The streamed-heading
regression observes entry into screenshot capture separately from completion.
Its duplicate-heading barriers prohibit capture entry; a deliberately defective
visibility-only readiness gate is the negative control and must enter capture
and fail the uniqueness assertion. No arbitrary sleeps or increased timeouts
are used.

### Deferred requirement: Authorized legacy REFUND_SUSPENSE allocation workflow

No such authorized workflow exists today. ALLOCATION_REQUIRED must remain held
and actionable; resolveFinanceIssue explicitly refuses to write it off.
A separate implementation requires explicit professional accounting policy,
SUPER_ADMIN/finance authorization, frozen allocation evidence, immutable
adjustment journals rather than journal rewrites, conflict and amount validation,
complete audit history, and dedicated design, security and financial review.
This correction does not introduce that workflow, alter frozen policies, change
schema/migrations or enable live payments or payouts.
