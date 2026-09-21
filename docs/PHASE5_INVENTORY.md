# Phase 5 route and environment inventory

## Current Phase 5 boundaries

The list below records the enforced boundary, not a claim that every possible permission combination has browser coverage. All authenticated routes use the full database-backed `auth()` implementation; the proxy role is only a navigation precheck. The proxy applies deployed configuration, origin, bounded body, shared rate and private-response controls. Machine routes retain their own authentication.

| API group | Authoritative boundary |
| --- | --- |
| `auth/[...nextauth]`, `auth/request-code` | Public passwordless entry; purpose-bound atomic codes, database throttles, secure device credentials |
| `account/profile`, `account/security` | Current account only; session rows scoped by user; rotation requires step-up |
| `admin/marketplace`, `admin/reservations/[id]/return-review` | ADMIN/SUPER_ADMIN plus current actor recheck and locked business state |
| `admin/reservations/[id]/emergency-override` | SUPER_ADMIN and dedicated fresh purpose-bound code; mandatory financial/jurisdiction trip gates |
| `admin/operations` | SUPER_ADMIN; mutations require security step-up, reason and audit; live charges cannot be enabled |
| `community` | Per-command participant/operator checks in conversation, review, case and notice services |
| `community/files/[id]`, `community/cases/[id]/photos/[photoId]` | Current case/conversation scope; attachment linkage, current membership, scan and evidence checks |
| `community/notices/[id]` | Recipient ownership and current target authorization before redirect |
| `community/sms` | Twilio signature for configured callback URL; handset-bound consent, STOP handling |
| `contact` | Public bounded/rate-limited contact intake; optional current account association |
| `cron/expire-holds`, `cron/financial/[worker]`, `cron/payouts/[worker]`, `cron/community`, `cron/operations/[worker]` | Constant-time bearer-secret verification before work; bounded allowlisted workers |
| `documents/upload` | Current uploader and owned reservation; image sanitization and fail-closed scanning |
| `documents/[id]` | Owner, existing ADMIN/STAFF review role or current host tenant; scan/read manifest gate and access audit |
| `finance`, `finance/export`, `finance/documents/[id]` | Finance service capabilities; FINANCE_AGENT/ADMIN/SUPER_ADMIN or current host with explicit finance grant; owner-only customer statements |
| `host/workspace`, `host/vehicles`, `host/reservations` | Current owner/active unexpired employee membership; owner/manager mutation capability where required |
| `host/files`, `host/vehicles/[id]/agreement` | Current tenant owner/manager for business files; only owner signs; no historical-uploader bypass |
| `marketplace/files/[id]` | Public only for CLEAN active approved listing photos in a visible jurisdiction; otherwise current business-file capability |
| `reservations`, `reservations/hold` | Current customer; hold admission under vehicle/reservation authority and jurisdiction/release gates |
| `reservations/[id]/checkout`, `payment-intent`, `retry-deposit`, `status`, `resume`, `cancel` | Customer ownership plus durable financial/state authorization inside the corresponding service |
| `reservations/[id]/confirm-dev-payment` | Explicit local-only simulation; impossible in staging/production or partial Stripe configuration |
| `reservations/[id]/experience`, `condition-reports`, `identity-handoff` | Current trip participant; host-only physical verification and role-specific trip commands |
| `reservations/[id]/condition-reports/[reportId]/accept` | Current trip participant and original report author; immutable accepted evidence |
| `reservations/[id]/photos/[photoId]` | Current participant or existing admin-area reviewer; photo must belong to that reservation |
| `reservations/[id]/agreement`, `receipt` | Customer/authorized agreement reviewer; receipt is customer-only; private streaming and audit |
| `reservations/[id]/trip-start-gate`, `start-trip` | Owned reservation/participant checks; start transaction revalidates financial, deposit, evidence and jurisdiction state |
| `vehicles/[id]/quote` | Public authoritative quote, only available inventory; sample/unapproved tax warning |
| `webhooks/stripe` | Signature over raw body; persisted event, exclusive lease and fencing |
| `health/live`, `health/ready` | Public sanitized boolean/status only; readiness performs non-destructive service checks |

Relevant tests include financial-http, community-http, marketplace-browser, staging-browser, business-file-revocation, return-financial-review, production-security, private-storage-provider, national-jurisdiction and the existing finance/retention concurrency suites. Route tests with an auth/provider mock cover that boundary's caller behavior, not real Auth.js or provider deployment; real-server browser tests cover those separately.

## Current provider and configuration inventory

| Component | Configuration family | Verification boundary |
| --- | --- | --- |
| Runtime | APP_ENV, SITE_URL, PRIMARY_DOMAIN, URL aliases, isolation labels | Typed syntax/isolation declarations; actual infrastructure identities require operator verification |
| PostgreSQL | DATABASE_URL, DIRECT_DATABASE_URL | TLS URL requirements, btree_gist, pinned session/advisory-lock readiness; real managed pool/load/PITR remains external |
| Auth | AUTH_SECRET, CRON_SECRET | Distinct high-entropy secrets; database session authority and machine authorization |
| Stripe payments/Connect | STRIPE_SECRET_KEY, publishable key, webhook secret, country, FINANCE_SANDBOX_ENABLED | Test-only provider guard; live movement remains prohibited |
| Email | RESEND_API_KEY, EMAIL_FROM | Required deployed syntax, durable outbox; sender verification/delivery exercise external |
| Private S3 | PRIVATE_STORAGE_* | Isolated private bucket, endpoint TLS, KMS key ARN, immutable hash/size and version deletion |
| Scanner | CLAMAV_HOST, PORT, TLS, optional CA certificate | TLS-verified INSTREAM/version protocol; actual signature maintenance external |
| Legacy/public images | CLOUDINARY_* | Existing public listing media and restricted legacy server-side reads; private manifest import required |
| SMS | TWILIO_* | Signed handset callback, purpose-specific consent and release gate; optional until approved |
| Rate storage | RATE_LIMIT_STORE=postgres | Shared durable budgets; trusted ingress header replacement required |
| Monitoring | MONITORING_ALERT_URL, MONITORING_ALERT_SECRET | HTTPS authenticated immutable alert delivery; receiver idempotency and external scheduler watchdog required |

Private data stores include S3/legacy objects, DriverDocument, MarketplaceFile, CollaborationFile, condition photos, AgreementAcceptance/AgreementArtifact, FinanceDocument, identity/contact/address fields, code hashes, sessions and restricted provider evidence. Finance PDFs and durable agreement render intent also reside in PostgreSQL and require encrypted managed storage/backups and restricted database access. No provider secret or private document is intentionally returned by the operator status API.

Operational worker names and schedules are maintained in OPERATIONS_RUNBOOK.md. Nine additive Phase 5 migrations are listed in PHASE5_PRODUCTION_READINESS.md. `.env.example` contains names and blank credentials, not deployable approvals.

## Original baseline inventory

Generated from the approved source before security implementation. Identifiers only; no environment values.

## API routes
- src/app/api/account/profile/route.ts
- src/app/api/admin/marketplace/route.ts
- src/app/api/admin/reservations/[id]/emergency-override/route.ts
- src/app/api/admin/reservations/[id]/return-review/route.ts
- src/app/api/auth/[...nextauth]/route.ts
- src/app/api/auth/request-code/route.ts
- src/app/api/community/cases/[id]/photos/[photoId]/route.ts
- src/app/api/community/files/[id]/route.ts
- src/app/api/community/notices/[id]/route.ts
- src/app/api/community/route.ts
- src/app/api/community/sms/route.ts
- src/app/api/contact/route.ts
- src/app/api/cron/community/route.ts
- src/app/api/cron/expire-holds/route.ts
- src/app/api/cron/financial/[worker]/route.ts
- src/app/api/cron/payouts/[worker]/route.ts
- src/app/api/documents/[id]/route.ts
- src/app/api/documents/upload/route.ts
- src/app/api/finance/documents/[id]/route.ts
- src/app/api/finance/export/route.ts
- src/app/api/finance/route.ts
- src/app/api/host/files/route.ts
- src/app/api/host/reservations/route.ts
- src/app/api/host/vehicles/[id]/agreement/route.ts
- src/app/api/host/vehicles/route.ts
- src/app/api/host/workspace/route.ts
- src/app/api/marketplace/files/[id]/route.ts
- src/app/api/reservations/[id]/agreement/route.ts
- src/app/api/reservations/[id]/cancel/route.ts
- src/app/api/reservations/[id]/checkout/route.ts
- src/app/api/reservations/[id]/condition-reports/[reportId]/accept/route.ts
- src/app/api/reservations/[id]/condition-reports/route.ts
- src/app/api/reservations/[id]/confirm-dev-payment/route.ts
- src/app/api/reservations/[id]/experience/route.ts
- src/app/api/reservations/[id]/identity-handoff/route.ts
- src/app/api/reservations/[id]/payment-intent/route.ts
- src/app/api/reservations/[id]/photos/[photoId]/route.ts
- src/app/api/reservations/[id]/receipt/route.ts
- src/app/api/reservations/[id]/resume/route.ts
- src/app/api/reservations/[id]/retry-deposit/route.ts
- src/app/api/reservations/[id]/start-trip/route.ts
- src/app/api/reservations/[id]/status/route.ts
- src/app/api/reservations/[id]/trip-start-gate/route.ts
- src/app/api/reservations/hold/route.ts
- src/app/api/reservations/route.ts
- src/app/api/vehicles/[id]/quote/route.ts
- src/app/api/webhooks/stripe/route.ts

## Referenced environment identifiers
- ALLOW_DEV_PAYMENT_SIMULATION
- ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV
- AUTH_URL
- CLAMAV_HOST
- CLAMAV_PORT
- CLOUDINARY_API_KEY
- CLOUDINARY_API_SECRET
- CLOUDINARY_CLOUD_NAME
- CRON_SECRET
- DATABASE_URL
- DIRECT_DATABASE_URL
- EMAIL_FROM
- FINANCE_SANDBOX_ENABLED
- NEXT_PUBLIC_SITE_URL
- NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
- NEXTAUTH_URL
- NODE_ENV
- RESEND_API_KEY
- STRIPE_CONNECT_COUNTRY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_FROM_NUMBER
- TWILIO_INBOUND_URL
