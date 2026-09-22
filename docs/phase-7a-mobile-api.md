# Phase 7A: native API foundation

Starting point: `7a4138de663f76b6f1d84cef1b40662b62ace7a9`. Implementation and verification are in progress; this document is not a production approval.

## Boundary inventory

| Existing boundary | Mobile reuse | Protection to preserve |
| --- | --- | --- |
| `auth-code.ts`, web NextAuth and `device-sessions.ts` | Shared hashed single-use code rules; separate native credential family | Web cookies remain web-only. Native credentials must not authorize web routes. |
| `checkout-hold.ts`, checkout/payment routes | Shared hold, checkout and durable provider services | Vehicle/reservation locks, immutable fingerprints, admission gates and provider recovery |
| `marketplace.ts`, `host-access.ts` | Current actor and tenant authorization | Never trust a device's stored role or host ID |
| `documents.ts`, private file routes | Shared validation, re-encoding, scanning and storage | Authorize before reading storage; quarantine remains inaccessible |
| Trip routes and trip-start gate | Shared trip services | Financial locks, identity handoff, agreement and deposit requirements |
| `conversations.ts`, `service-cases.ts`, `trip-reviews.ts` | Shared customer/host services | Current participants, financial holds, moderation and immutable evidence |
| `finance-ledger.ts`, payout services | Allowlisted earnings reads only | No mobile administrative financial mutations or allocation workflow |
| Admin, finance step-up, emergency override | Web-only | Existing separately authenticated and audited procedures |

## Contract and lifecycle

The native namespace is `/api/v1/mobile`. Responses must carry a server-generated request ID, API version, a consistent envelope and `private, no-store`. Collection requests have bounded pagination. Input bodies are bounded before parsing. Output is explicitly selected; raw database entities are not a public contract.

Native requests use bearer credentials, never ambient cookies. Browser cookie CSRF protection remains unchanged outside this namespace. Native credentials must be stored only in iOS Keychain or Android Keystore/SecureStore, never AsyncStorage/localStorage. Refresh rotation is serialized in PostgreSQL, with retained consumed credential hashes for reuse detection and family revocation. Every access and refresh checks current account and device state. A lost rotation response requires signing in again rather than relaxing replay protection.

Mutations require user- and operation-bound idempotency keys and immutable request fingerprints. A response cache alone does not provide crash safety: the domain write and deduplication result must commit together, or an existing durable domain intent must be resumed.

## Delivery constraints

Live payments and payouts remain disabled. No complete mobile UI is included. CI must verify fresh/populated migration safety, repeated PostgreSQL security and concurrency tests, HTTP behavior, contract/client drift and existing financial suites before this batch is reported complete.
