# Phase 7A: native API and device authentication

Base: `7a4138de663f76b6f1d84cef1b40662b62ace7a9`. Branch: `codex/phase-7a-mobile-api-auth`. Draft PR: https://github.com/hemanthvuddagiri13-oss/Rent-a-4-wheel/pull/7.

This is an API foundation for a future customer/host Expo application, not a complete mobile application or production approval. Live payments and payouts remain disabled. No existing approval or migration is rewritten.

## Boundary audit

| Existing boundary | Native reuse | Authority retained |
| --- | --- | --- |
| `auth-code.ts`, NextAuth, `device-sessions.ts` | Shared code rules; separate native credential family | Web cookies never become native credentials; native tokens never become web sessions |
| `checkout-hold.ts`, checkout route | Shared hold service and extracted `checkout-service.ts` | Vehicle/reservation locks, immutable checkout evidence, current jurisdiction/release gates, frozen pricing and agreements |
| Customer cancel/start routes | Extracted `customer-reservation.ts`, used by web and native | Reservation lock, original status machine, durable cancellation outbox and complete trip-start gate |
| `marketplace.ts`, `host-access.ts`, collaboration guards | Current database actor and host membership | No client-supplied role, host ID or stale device-role claims |
| Documents and private storage | Shared validation, image re-encoding, scanner, durable private write intent | Owner/tenant authorization before storage; CLEAN required even for native owner previews |
| Condition reports and trip experience | Extracted shared report save/accept service; existing trip commands | Reservation lock, participant identity, report completeness, acceptance and financial review holds |
| Conversations, cases, reviews | Existing services accept an existing transaction via `domain-transaction.ts` | Domain write and native receipt commit atomically; current participant and optimistic-version checks |
| Finance ledger and payouts | Owner-only allowlisted earnings reads and customer payment projection | No mobile provider, refund, accounting, allocation, payout or emergency-override mutation |

Web-only in this batch: host onboarding and listing/availability administration; physical identity handoff verification; Stripe SDK payment/deposit authorization and different-card handoff; agreement PDF download; business-document and inspection-photo download; case attachment/moderation/operator workflows; notification preferences; admin/finance/security step-up and emergency overrides. Native checkout prepares immutable booking/agreement evidence but does not create or confirm a provider payment. Those future mobile handoffs require separately scoped contracts; clients must not infer payment success from checkout success. Discovery is a paginated catalog, not a date-filtered search API; the shared hold service is authoritative for dated availability.

## HTTP and contract

There are 46 operations under `/api/v1/mobile`. The exact endpoint inventory follows below and is machine-readable in `docs/api/mobile-v1.openapi.json`. `src/lib/mobile/contract.ts` owns strict Zod request/response schemas. Runtime serialization validates allowlisted DTOs against the same schemas. A newly added response field fails closed until the contract explicitly allows it.

JSON responses are `{ data, error, requestId }`; errors expose a fixed code, not internal exception text. Successful private-file responses are binary with the same version/request/privacy headers. Every response has server-generated `X-Request-ID`, `X-API-Version: 1`, `Cache-Control: private, no-store`, `Vary: Authorization` and nosniff/CSP headers. Unknown operations return 404; unsupported requested versions return 400. Lists default to 20, maximum 50, with opaque record-ID cursors. Reservation child collections have explicit small limits.

JSON is streamed and bounded at 24,000 bytes. Raw initialized image finalization is bounded at 8 MiB, with exact declared length/hash/media checks. Proxy rejection also uses the native error envelope. Existing global proxy abuse/configuration controls remain in force. Cookie CSRF exemptions apply only to this bearer-only namespace; all other web protections remain unchanged.

Authentication requests have a shared database limit of 30/minute per trusted ingress IP; general mobile requests 120/minute, plus existing marketplace mutation limits. Issuance additionally uses the shared account/IP limits below. Missing trusted IPs share an unknown bucket. Deployment ingress MUST strip and replace `x-real-ip`; no client forwarding chain establishes identity. Mobile audit IP evidence is HMAC-derived. Request telemetry contains only fixed operation ID, request ID, status and elapsed milliseconds; it never logs URLs, headers, tokens or payloads. Throttled code issuance is audited without changing the enumeration-resistant response.

## Authentication and device lifecycle

1. Request a `MOBILE_SIGN_IN` code. Issuance always returns `{ accepted: true }` for valid requests, including unknown/disabled/throttled accounts. No development code is returned by the native API.
2. Shared bcrypt-hashed codes expire after 10 minutes, allow five attempts, use a 60-second resend cooldown and cap issuance at five/account/hour and twenty/IP/hour. PostgreSQL advisory guards serialize issuance and consumption. Native codes cannot satisfy web sign-in or step-up purposes.
3. A successful code creates a CUSTOMER only when the user does not already exist. Existing roles and inactive status are never reset. Eligible native roles are CUSTOMER, HOST and HOST_EMPLOYEE. Other roles cannot receive or refresh native credentials.
4. App-generated UUID, IOS/ANDROID, bounded app version and necessary lifecycle timestamps are persisted. No hardware ID, advertising ID or fingerprint is collected. Reauthentication replaces the same app device; at most 20 active device families remain, with audited oldest-device revocation.
5. Access and refresh tokens each contain 256 random bits. Only SHA-256 hashes are persisted. Access lasts five minutes, refresh seven days of inactivity, and the family has a fixed 30-day maximum. Every access/refresh checks current account, role, family and generation.
6. Refresh locks the current User row, consumes the old generation and inserts the new generation atomically. Reusing a consumed token commits revocation of the entire family before returning 401. A lost refresh response requires a fresh sign-in; the client must serialize refresh and must not blindly retry it.
7. Logout, own-device revocation and logout-all are immediate for subsequent native requests. Web sessions are independent. Rotation and domain mutations avoid holding a device write lock while waiting on domain User locks. Already-authorized in-flight operations are not retroactively undone; domain state and participant checks still govern their commit.

The generated client does not persist credentials or retry requests. The future application must use iOS Keychain or Android Keystore/SecureStore, never AsyncStorage/localStorage, and use TLS with certificate validation. Device compromise is not solved by bearer tokens. No biometric/device-attestation claim is made.

## Authorization matrix

| Operation | Customer | Current host owner | Current host employee | Admin/support/finance roles |
| --- | --- | --- | --- | --- |
| Public catalog | Public approved visible jurisdictions only | Same | Same | Public only |
| Own account/devices | Own | Own | Own | No native login |
| Reservation/trip/agreement/document status | Own reservation | Own vehicle tenant | Active current vehicle tenant | Unavailable through native credentials |
| Hold and checkout/cancel/start | Customer owns reservation; all domain gates | Only if reservation customer, never by host authority | Same | Unavailable |
| Keys and return completion | Denied | Assigned host and gate/return guards | Current assigned host membership and same guards | Unavailable |
| Begin return, reports, messages, cases, reviews | Current participant and domain rules | Current participant and domain rules | Current participant and domain rules | Unavailable |
| Identity preview | Own CLEAN nonexpired document | CLEAN document on own tenant reservation | CLEAN document on current tenant reservation | Unavailable |
| Host fleet/reservations | Denied | Own tenant | Current active tenant | Unavailable |
| Safe host earnings | Denied | OWNER only | Denied | Unavailable |
| Financial mutations, step-up, override | Unavailable | Unavailable | Unavailable | Existing protected web workflows only |

A host role alone never grants access to an arbitrary reservation or file. Removed/expired employees and suspended hosts lose tenant access on the next request without token renewal. Safe earnings omit bank/provider IDs and payout mutation controls; `payoutEnabled` is always false. Payment status uses the existing financial projection, not a client assertion. Pricing separates frozen components where evidence exists; unknown historical components remain null. Approval remains SAMPLE_UNAPPROVED, never inferred from arithmetic.

## Durable retries, uploads and private access

All domain mutations require a 16–128 character idempotency key, scoped to user and operation with an immutable request fingerprint. PostgreSQL transaction advisory locks serialize equal keys. Changed content returns 409. Resource authorization is repeated even when a receipt already exists. Domain writes and receipt insertion share one transaction; rollback creates neither. Provider work must use existing durable operations/outboxes and may not run inside the receipt transaction.

A retried hold returns the original resource, not a renewed expiration. Checkout rechecks current hold expiration, financial disposition, admission and displayed agreement hash even on replay. A receipt never supplies availability or financial authority. Agreement acceptance queues the existing durable AGREEMENT job. Cancellation and trip transitions use existing locks and compensation/recovery services. No Stripe call is introduced by the native API.

Upload initialization freezes owner, purpose, optional reservation, raw content hash/size/media and 15-minute expiration. Finalization binds its key durably before storage IO, re-encodes the image, requires a CLEAN scanner result, then uses the existing private storage service with the stable upload UUID. Ambiguous writes remain review-blocked in that service; retries cannot allocate a fresh identity. Final document metadata and completion receipt commit under the upload lock. Report photos accept only finalized, owned INSPECTION upload IDs for that reservation, never arbitrary storage keys.

Identity access uses a 60-second HMAC capability bound to document, user, device family and IDENTITY_PREVIEW purpose. Redemption requires both the bearer credential and `X-File-Access`, repeats current authorization and quarantine checks, and logs access before the shared private storage read. It does not expose a public/signed storage URL. Agreement text/hash and report metadata are available; unsupported private download types remain in the authenticated web workflow rather than gaining a weaker preview path. No real identity evidence is used in tests/artifacts.

## Migrations and verification

Two additive migrations: `20260923000000_mobile_credentials` (native code purpose, sessions, hashed credentials and mutation receipts) and `20260923001000_mobile_upload_intent` (upload intents). No historical migration is changed. The populated upgrade test starts before these migrations with existing web sessions/codes, payment, reservation, frozen finance quote and ALLOCATION_REQUIRED issue, and checks exact preservation plus empty native tables/no released holds or journals.

`tests/mobile-security.test.ts` contains 31 PostgreSQL/HTTP cases; `mobile-contract.test.ts` contains four; `mobile-migration.test.ts` contains one. The mobile workflow runs all 36 cases five consecutive times, validates OpenAPI 3.1 with external reference resolution disabled, checks deterministic generated-client drift, performs a low-severity dependency audit, deploys fresh migrations, seeds and runs type generation/typecheck/lint. Counts describe required suite composition; passing evidence is the exact-head Actions run, not this document.

Concurrency cases use independent Prisma clients capped at one connection, assert distinct `pg_backend_pid()` values and synchronize via barriers: simultaneous refresh, identical message receipts, overlapping holds, and refresh versus a domain User lock. They do not use arbitrary sleeps to simulate races. The rollback test fails after the domain write but before receipt commit and proves neither survives. Storage/scanner/email are explicit external-boundary doubles in the mobile HTTP suite; sanitizer, database, auth, route handlers and domain locks are real. Existing private-storage/provider recovery suites cover that service separately.

The existing financial workflow performs production build, five real production Next.js/TLS browser tests twice (including native bearer/web-cookie isolation), full suite twice and all existing critical financial/concurrency groups five times. The Phase 6 UI workflow continues automatically; no visual baseline or assertion is weakened. Local PostgreSQL process restrictions mean real database/browser execution is verified in GitHub Actions, not claimed from local runs. Exact final SHA, counts, job conclusions and links belong in the PR delivery report.

Generate/check: `npx tsx scripts/generate-mobile-contract.ts [--check]`; validate: `node scripts/validate-mobile-openapi.mjs`. The private TypeScript source package `packages/mobile-client` exports the typed operation map, metadata, `createMobileClient` and `MobileApiError`; HTTPS is mandatory except explicit localhost test configuration. It includes no Expo UI or credential storage adapter.

## Remaining launch requirements

Production remains blocked by existing jurisdiction/legal/insurance/tax/payment/payout approvals and release gates. Rates remain sample/unapproved. This batch does not enable live finance. Before a native launch: implement/review the web-only native handoffs above; integrate and test Keychain/Keystore on real iOS/Android devices; validate ingress header stripping, production email/scanner/private storage and operational recovery; approve retention/cleanup policy for consumed credential hashes, receipts and abandoned upload intents without erasing reuse evidence or held objects; conduct independent security review. The API deliberately retains evidence conservatively rather than inventing a legally approved deletion policy.

ALLOCATION_REQUIRED remains unresolved and held. An **Authorized legacy REFUND_SUSPENSE allocation workflow** is a separate future requirement needing professional accounting policy, SUPER_ADMIN/finance authorization, frozen evidence, immutable adjustment journals, conflict/amount validation, complete audit history and dedicated design/security/financial review. No allocation workflow is added here.

## Exact operation inventory

| Method | Path | Client operation |
| --- | --- | --- |
| POST | /api/v1/mobile/auth/request-code | requestCode |
| POST | /api/v1/mobile/auth/sign-in | signIn |
| POST | /api/v1/mobile/auth/refresh | refresh |
| POST | /api/v1/mobile/auth/logout | logout |
| POST | /api/v1/mobile/auth/logout-all | logoutAll |
| POST | /api/v1/mobile/auth/revoke | revokeDevice |
| GET | /api/v1/mobile/auth/devices | devices |
| GET | /api/v1/mobile/me | me |
| GET | /api/v1/mobile/vehicles | vehicles |
| GET | /api/v1/mobile/vehicles/{id} | vehicle |
| GET | /api/v1/mobile/reservations | reservations |
| GET | /api/v1/mobile/reservations/{id} | reservation |
| POST | /api/v1/mobile/reservations/hold | hold |
| POST | /api/v1/mobile/reservations/{id}/checkout | checkout |
| GET | /api/v1/mobile/reservations/{id}/agreement-preview | agreementPreview |
| GET | /api/v1/mobile/reservations/{id}/pricing | pricing |
| POST | /api/v1/mobile/reservations/{id}/cancel | tripCancel |
| POST | /api/v1/mobile/reservations/{id}/start | tripStart |
| POST | /api/v1/mobile/reservations/{id}/keys | tripKeys |
| POST | /api/v1/mobile/reservations/{id}/return | tripReturn |
| POST | /api/v1/mobile/reservations/{id}/complete | tripComplete |
| GET | /api/v1/mobile/reservations/{id}/payment-status | paymentStatus |
| GET | /api/v1/mobile/reservations/{id}/agreements | agreements |
| GET | /api/v1/mobile/reservations/{id}/trip | trip |
| GET | /api/v1/mobile/reservations/{id}/documents | reservationDocuments |
| GET | /api/v1/mobile/documents | documents |
| POST | /api/v1/mobile/uploads | initializeUpload |
| POST | /api/v1/mobile/uploads/{id}/finalize | finalizeUpload |
| POST | /api/v1/mobile/files/access | documentAccess |
| GET | /api/v1/mobile/files/{id} | privateDocument |
| GET | /api/v1/mobile/reservations/{id}/reports | reports |
| POST | /api/v1/mobile/reservations/{id}/reports | submitReport |
| POST | /api/v1/mobile/reservations/{id}/reports/{reportId}/accept | acceptReport |
| GET | /api/v1/mobile/conversations | conversations |
| POST | /api/v1/mobile/conversations | openConversation |
| GET | /api/v1/mobile/conversations/{id} | messages |
| POST | /api/v1/mobile/conversations/{id}/messages | sendMessage |
| GET | /api/v1/mobile/notifications | notifications |
| GET | /api/v1/mobile/cases | cases |
| POST | /api/v1/mobile/cases | openCase |
| GET | /api/v1/mobile/cases/{id} | serviceCase |
| POST | /api/v1/mobile/cases/{id}/reply | replyCase |
| POST | /api/v1/mobile/reviews | saveReview |
| GET | /api/v1/mobile/host/fleet | hostFleet |
| GET | /api/v1/mobile/host/reservations | hostReservations |
| GET | /api/v1/mobile/host/earnings | hostEarnings |
