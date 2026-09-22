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
