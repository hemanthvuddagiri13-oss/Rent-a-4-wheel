# Rent A 4Wheel

Daily, weekly, and monthly car rental platform for Rent A 4Wheel (Dallas, TX) —
built with Next.js App Router, TypeScript, Tailwind CSS, Prisma/PostgreSQL,
NextAuth (Auth.js), Stripe, Resend, and Cloudinary.

> **Primary domain:** `renta4wheel.com` · **Secondary domain:** `rentafourwheel.com`
> (301-redirects to the primary domain — see [Domain Configuration](#domain-configuration)).

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Local Setup](#local-setup)
3. [Environment Variables](#environment-variables)
4. [Database Setup & Migrations](#database-setup--migrations)
5. [Seeding Demo Data](#seeding-demo-data)
6. [Creating an Admin Account](#creating-an-admin-account)
7. [Third-Party Service Setup](#third-party-service-setup)
8. [Running the App](#running-the-app)
9. [Testing](#testing)
10. [Architecture Overview](#architecture-overview)
11. [Domain Configuration](#domain-configuration)
12. [Deployment (Vercel)](#deployment-vercel)
13. [Backups](#backups)
14. [Legal Content](#legal-content)
15. [Production Checklist](#production-checklist)

---

## Tech Stack

- **Framework:** Next.js (App Router, Turbopack, Server Actions)
- **Language:** TypeScript
- **Styling:** Tailwind CSS v4 + hand-rolled shadcn/ui-style components (Radix primitives)
- **Database/ORM:** PostgreSQL + Prisma
- **Auth:** Auth.js (NextAuth v5) — passwordless six-digit email-code sign-in (no passwords anywhere in the system), JWT sessions, role-based access
- **Payments:** Stripe (PaymentIntents, webhooks)
- **Email:** Resend (transactional templates)
- **Images/Documents:** Cloudinary (public vehicle photos + private, authenticated document storage), with a local-disk fallback for development
- **Validation:** Zod
- **Forms:** native forms + Server Actions (admin) / React state (booking wizard)
- **Charts:** Recharts
- **PDF generation:** pdf-lib (rental agreement)
- **Testing:** Vitest

---

## Local Setup

```bash
git clone <this-repo>
cd rent-a-4wheel
npm install
cp .env.example .env
```

Fill in `.env` (see [Environment Variables](#environment-variables)), then:

```bash
npm run db:migrate   # applies Prisma migrations
npm run db:seed      # seeds ~10 demo vehicles + admin/demo accounts
npm run dev          # http://localhost:3000
```

## Environment Variables

All secrets are read from environment variables — **never hard-coded**. See
[`.env.example`](./.env.example) for the full list and inline comments. Key
groups:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (Prisma) |
| `AUTH_SECRET`, `NEXTAUTH_URL` | Auth.js session signing / base URL |
| `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Image/document storage |
| `TWILIO_*` | SMS architecture (not wired to send until consent flow is built) |
| `NEXT_PUBLIC_GA4_MEASUREMENT_ID`, `NEXT_PUBLIC_META_PIXEL_ID` | Analytics |
| `SEED_ADMIN_EMAIL` | Bootstrap admin account email used by `npm run db:seed` (no password — see Authentication below) |
| `CRON_SECRET` | Bearer-token secret required to call `/api/cron/expire-holds` (background checkout-hold cleanup) |

**Authentication is passwordless.** There is no password field anywhere in
the schema. Signing in means: enter an email → receive a six-digit code
(hashed, single-use, 10-minute expiry, rate-limited by email and IP, resend
cooldown, attempt-limited) → enter the code. An account is created
automatically on first verified sign-in. See `src/lib/auth-code.ts`.

**Development without credentials:** Stripe, Resend, and Cloudinary all
degrade gracefully when their keys are missing:

- **Stripe absent** → the booking payment step shows a clearly labeled
  "Development Mode" panel with a **Simulate Successful Payment** button, so
  the full booking flow (through confirmation + PDF agreement) can be tested
  end to end. This simulate-payment endpoint refuses to run in production or
  once real Stripe keys are present, regardless of `NODE_ENV`.
- **Resend absent** → emails (including sign-in codes) are logged to the
  server console instead of sent, and `Notification` rows are still
  recorded with a `FAILED` status and an explanatory error message. The
  `/api/auth/request-code` response also echoes the code back in this case
  (development only — never in production) so you can sign in without a
  real inbox.
- **Cloudinary absent** → uploaded driver's license documents are written to
  `private-storage/` on disk (git-ignored, served only via the authenticated
  `/api/documents/[id]` route — never from `/public`).

## Database Setup & Migrations

```bash
npm run db:migrate     # `prisma migrate dev` — creates/applies migrations
npm run db:studio      # Prisma Studio GUI
npx prisma generate    # regenerate the client after schema changes
```

Schema lives at [`prisma/schema.prisma`](./prisma/schema.prisma) and models
users/passwordless auth codes, hosts (host profiles, employees, Stripe
Connect fields), vehicles, images, features, ownership, the reservation
state machine (17 statuses, checkout holds, exclusion-constraint-protected
overlap prevention), extras, payments, the Stripe webhook idempotency
ledger, refunds, security deposits, driver identity documents (with access
audit logging and retention), versioned legal agreement acceptances, trip
lifecycle models (Trip, ConditionReport/Photo, IdentityHandoffVerification,
TripChecklist, TripEvent), fleet operations (blocks, inspections, damage
reports, maintenance), coupons, reviews, contact messages, FAQ,
notifications, audit logs, and admin-editable site settings.

One migration (`prisma/migrations/*_phase1_booking_payment_identity_trip_foundation`)
hand-adds a PostgreSQL `EXCLUDE USING gist` constraint (requires the
`btree_gist` extension, created via `CREATE EXTENSION IF NOT EXISTS` in the
same migration) that makes it *database-impossible* for two
CONFIRMED-or-later reservations on the same vehicle to have overlapping
date ranges — independent of and in addition to the application-level
SERIALIZABLE-transaction checks. See the comments in that migration file
for why checkout holds (which expire) are deliberately *not* covered by
this hard constraint and rely on the transactional check instead.

## Seeding Demo Data

```bash
npm run db:seed
```

Seeds:
- 10 **sample** vehicles (clearly flagged `isDemo: true`) across Economy,
  Sedan, SUV, Luxury, and Truck categories, with placeholder imagery
  (`public/images/vehicles/*.svg`) — **not real inventory**.
- An admin account (`SEED_ADMIN_EMAIL`, default `admin@renta4wheel.com`) —
  sign in with a one-time email code, there is no password.
- A demo customer account (`demo.customer@example.com`) — same, passwordless.
- Optional extras, an inactive `WELCOME10` coupon, placeholder legal
  documents (all flagged `needsAttorneyReview: true`), FAQ content, sample
  published reviews (flagged `isDemo: true` — never fabricated Google
  reviews), and default site settings.

## Creating an Admin Account

The seed script creates one automatically. To promote another user or
create a fresh one in production:

```bash
npx prisma studio
# User table → set role = ADMIN for the target user
```

or via `psql`:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'you@example.com';
```

## Third-Party Service Setup

### Stripe

1. Create a [Stripe account](https://dashboard.stripe.com/register).
2. Copy the **Secret key** → `STRIPE_SECRET_KEY`, **Publishable key** →
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
3. Add a webhook endpoint pointing to `https://<your-domain>/api/webhooks/stripe`
   listening for `payment_intent.succeeded` and `payment_intent.payment_failed`.
   Copy the signing secret → `STRIPE_WEBHOOK_SECRET`.
4. For local testing, use the [Stripe CLI](https://stripe.com/docs/stripe-cli):
   `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.

### Resend

1. Create a [Resend account](https://resend.com) and verify your sending domain.
2. Create an API key → `RESEND_API_KEY`.
3. Set `EMAIL_FROM` to a verified sender, e.g. `Rent A 4Wheel <bookings@renta4wheel.com>`.

### Cloudinary

1. Create a [Cloudinary account](https://cloudinary.com).
2. Copy Cloud Name / API Key / API Secret into the corresponding env vars.
3. Driver documents upload with `type: authenticated` (never publicly
   browsable); retrieval always goes through a signed, time-limited URL
   generated server-side in `src/lib/storage.ts`.

## Running the App

```bash
npm run dev         # development server (Turbopack)
npm run build        # production build
npm run start         # serve the production build
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm test               # Vitest
```

## Testing

`npm test` runs the Vitest suite (`tests/`), covering the flows called out
in the project brief:

- **Pricing** — daily/weekly/monthly rate selection, extras (one-time,
  daily, percentage), coupon discounts, tax rounding (`tests/pricing.test.ts`).
- **Coupons** — every validity rule: inactive, not-yet-started, expired,
  minimum rental days, usage cap, vehicle restriction (`tests/pricing.test.ts`).
- **Availability & overlapping reservations** — every overlap
  configuration (contained, partial, containing, back-to-back,
  disjoint), scoped correctly per-vehicle (`tests/availability.test.ts`).
- **Booking / double-booking prevention** — fires two concurrent
  `SERIALIZABLE` booking transactions for the same vehicle and time slot and
  asserts exactly one commits (`tests/availability.test.ts`).
- **Cancellation** — the customer self-cancel eligibility rules
  (`tests/reservation-rules.test.ts`).
- **Admin permissions** — role-based access helpers used by middleware and
  every admin Server Action (`tests/rbac.test.ts`).
- **Reservation state machine** — every legal/illegal transition, the
  compare-and-swap guard against concurrent transitions, and the
  stale-state error path (`tests/reservation-state-machine.test.ts`).
- **Checkout holds** — a live hold blocks competing checkout, an expired
  hold does not (even before the cleanup job runs), the background sweep
  (`expireStaleReservations`) flips only truly-expired rows, and only one
  of two simultaneous SERIALIZABLE hold-creation attempts for the same slot
  succeeds (`tests/checkout-holds.test.ts`).
- **Payments/deposit gating and webhook idempotency** — rental payment
  success with no deposit required confirms the reservation; rental
  payment success *with* a required deposit only confirms once the
  deposit authorization also succeeds, and leaves it `PAYMENT_FAILED`
  (never `CONFIRMED`) when the deposit authorization fails; re-delivering
  an already-processed event, and an out-of-order failure event arriving
  after a success event, are both safe no-ops; the `StripeEvent` ledger's
  unique constraint rejects a duplicate event ID at the database level
  (`tests/payments-webhook.test.ts`, Stripe SDK calls mocked).
- **Identity document ownership** — a document can be attached to a
  reservation its uploader owns, and is rejected when uploaded by a
  different user or already attached to a different reservation
  (`tests/document-ownership.test.ts`).
- **Host cross-tenant access** — a host (or their employee) can access
  their own vehicles/reservations and is denied access to another host's,
  and a user with no host affiliation gets no host context at all
  (`tests/host-access.test.ts`).
- **Trip-start gate** — the complete happy path where every precondition
  (payment, deposit, all three identity documents including the selfie,
  signed agreement, host identity-handoff verification, both parties'
  accepted pre-trip condition reports with photos, pickup within the
  check-in window) is satisfied, plus one test per individually-missing
  precondition (`tests/trip-gate.test.ts`).

The availability/booking/state-machine/checkout-hold/document/host-access/
trip-gate tests are integration tests that run against a real PostgreSQL
database (`DATABASE_URL`, via `tests/helpers/factories.ts`) and clean up
every row they create, in FK-safe order. The webhook tests mock the Stripe
SDK client (`vi.mock("@/lib/stripe")`) so deposit-authorization
success/failure is deterministic without a real Stripe account.

### Hardening pass (post-review corrections)

Following an independent review of the Phase 1 foundation, a second pass
fixed several correctness/deployment issues and added their tests:

- **Stripe webhook processing is a real state machine**
  (`RECEIVED -> PROCESSING -> PROCESSED`/`FAILED`, with `attemptCount`,
  `lastError`, `nextRetryAt`) instead of "claim by row existence" — a
  failed processing attempt is retryable, a stale `PROCESSING` row (the
  process handling it crashed) is reclaimable, and the webhook route
  returns HTTP 500 on failure so Stripe's own retry schedule kicks in too.
  See `src/lib/stripe-event-ledger.ts` and `tests/stripe-event-ledger.test.ts`.
- **Payment reconciliation** (`src/lib/payment-reconciliation.ts`,
  `PaymentReconciliation` model) handles every case where a Stripe charge
  succeeded but couldn't cleanly produce a confirmed reservation: a
  temporary Stripe-side error during deposit authorization propagates and
  retries rather than being recorded as a permanent decline; a rental
  payment that succeeds after its checkout hold expired is either
  auto-resolved (the exact reservation is narrowly reopened and confirmed,
  under a fresh serializable availability check) or automatically refunded
  with an explicit review record if the dates are genuinely gone — a
  successful charge is never silently lost. See
  `tests/payments-webhook.test.ts`.
- **Checkout-hold refresh no longer resurrects a lost slot**: refreshing
  an already-expired hold now explicitly releases it (its own committed
  step) and re-checks availability from scratch before creating a new
  one, so a customer whose hold expired while someone else booked the
  same dates gets a conflict, not their old dates back. See
  `src/lib/checkout-hold.ts` and `tests/checkout-holds.test.ts`.
- **The Phase-1 migration now safely handles a database that already has
  data**, not just a fresh one: legacy `PENDING`/`CONFIRMED`/`ACTIVE`/
  `COMPLETED`/`CANCELLED` reservation statuses are explicitly mapped
  (documented in the migration file) instead of a bare enum cast that
  fails outright on existing rows; `DriverDocument`'s new required columns
  are backfilled before being made `NOT NULL`; and the retired
  `RentalAgreement` table's rows are migrated into `AgreementAcceptance`
  before the table is dropped. `tests/migration-existing-data.test.ts`
  spins up a throwaway database, applies the original pre-Phase-1 schema,
  inserts old-shaped fixture rows, then runs `prisma migrate deploy` for
  real and asserts every row survived correctly mapped.
- **Auth-code verification is atomically single-use**: the final "mark
  consumed" step is a conditional `updateMany` (matching ID + unconsumed +
  under the attempt limit + unexpired) rather than an unconditional
  update, so two simultaneous submissions of the same valid code can never
  both succeed. See `tests/auth-code-concurrency.test.ts`.
- **The ordinary admin "quick start rental" / "quick complete rental"
  buttons have been removed.** The only way to force a reservation past an
  unmet Start Trip / Return gate is now a dedicated, `SUPER_ADMIN`-only,
  step-up-verified (a fresh email-code check — the closest equivalent to
  MFA this system has, since no TOTP/WebAuthn factor exists yet),
  reason-required, explicitly confirmed, and fully audited emergency
  override (`src/lib/emergency-override.ts`, `EmergencyOverrideRecord`,
  `POST /api/admin/reservations/[id]/emergency-override`), which also
  notifies both the customer and the host. See
  `tests/emergency-override.test.ts`.
- **Malware scanning is fail-closed.** `MalwareScanStatus.NOT_SCANNED` was
  renamed to `QUARANTINED` (a newly uploaded, unscanned document is
  actively held back, not merely "pending"). Since no scanner is
  configured in this environment, every upload is rejected in production;
  in development it requires an explicit
  `ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV=true` opt-in. A non-owner (host,
  staff reviewer) can never view a document until its scan status is
  actually `CLEAN`. Identity documents also no longer accept PDF — images
  only, re-encoded through sharp — since this deployment has no
  PDF-capable scanner and an unscanned PDF can carry active content. See
  `src/lib/documents.ts` and `tests/malware-scan-fail-closed.test.ts`.

Every scenario above has a dedicated test, and the full suite
(`npm test`) was run twice in a row for stability alongside a fresh-database
migration, a populated-old-database migration, seed, typecheck, lint, and
a production build — see the PR description for exact results.

## Architecture Overview

```
src/
  app/                      # App Router routes
    (public site pages)     # /, /vehicles, /vehicles/[slug], /how-it-works, ...
    book/[vehicleId]/       # 7-step booking wizard
    account/                # customer dashboard
    admin/                  # role-gated staff/admin dashboard
    api/                    # route handlers (reservations, payments, webhooks, documents, auth)
  components/               # ui/ (primitives), layout/, home/, vehicles/, booking/, admin/, account/, auth/
  lib/                      # pricing, availability, storage, email, notifications, stripe, settings, rbac, validations/
prisma/
  schema.prisma             # full data model
  seed.ts                   # demo data
tests/                       # Vitest suite
```

**Key business logic lives in `src/lib/`, not in route handlers**, so it's
independently testable:

- `pricing.ts` — server-authoritative rate selection + full price
  breakdown (rental, extras, discount, tax, fees, deposit). The client
  never computes totals; every price shown anywhere in the app comes from
  either `/api/vehicles/[id]/quote` or the reservation-creation transaction,
  both of which call this module.
- `availability.ts` — overlap-safe availability checks, reused by search,
  the vehicle detail page, the quote endpoint, and reservation creation.
- Reservation creation (`/api/reservations`) wraps the availability
  re-check + pricing computation + write in a single `SERIALIZABLE` Prisma
  transaction, so two simultaneous bookings for the same vehicle/dates
  cannot both succeed (see the concurrency test).
- `storage.ts` — private document storage abstraction (Cloudinary
  authenticated delivery in production, local disk in development), never
  exposed under `/public`.
- `rbac.ts` — the single source of truth for "who can access `/admin`" /
  "who can change site-wide settings," used by both `src/proxy.ts`
  (route-level gate) and every admin Server Action (defense in depth).

## Domain Configuration

**Primary canonical domain:** `renta4wheel.com`. All metadata
(`metadataBase`, canonical tags, OpenGraph URLs, sitemap, structured data)
reference this domain via `NEXT_PUBLIC_SITE_URL`.

**Secondary domain (`rentafourwheel.com`) must 301-redirect** to the
primary domain. Two layers implement this — configure both:

1. **App-level (already implemented):** `next.config.ts` defines a
   `redirects()` rule matching the `Host` header for `rentafourwheel.com`,
   `www.rentafourwheel.com`, and `www.renta4wheel.com`, 301-redirecting to
   `https://renta4wheel.com` while preserving the path. This works as long
   as DNS for the secondary domain points at the same deployment.
2. **Hosting/DNS-level (do this in your registrar/Vercel dashboard):**
   - Add both `renta4wheel.com` and `rentafourwheel.com` as domains on the
     same Vercel project.
   - In Vercel's domain settings, mark `renta4wheel.com` as the primary
     "Production" domain — Vercel will then also 301-redirect
     `rentafourwheel.com` at the edge automatically, before it even reaches
     the app. This is the recommended primary mechanism; the
     `next.config.ts` rule is a safety net.

## Deployment (Vercel)

1. Push this repo to GitHub/GitLab/Bitbucket and import it into
   [Vercel](https://vercel.com/new).
2. Add all variables from `.env.example` to the Vercel project's
   Environment Variables (Production + Preview as appropriate).
3. Use a managed PostgreSQL provider compatible with Prisma — e.g.
   [Neon](https://neon.tech), [Supabase](https://supabase.com), or
   [Vercel Postgres](https://vercel.com/storage/postgres). Set
   `DATABASE_URL` accordingly.
4. Add a Vercel deploy step (or run manually once) for migrations:
   ```bash
   npx prisma migrate deploy
   ```
5. Configure both domains as described in
   [Domain Configuration](#domain-configuration).
6. Point the Stripe webhook at
   `https://renta4wheel.com/api/webhooks/stripe`.
7. Seed production data deliberately — **do not** run `npm run db:seed`
   against production with default demo data; instead add real vehicles via
   `/admin/vehicles` after creating a real admin account.

## Backups

- If using a managed Postgres provider (Neon/Supabase/RDS/etc.), enable
  their automated daily backups / point-in-time recovery — this is the
  primary backup mechanism and requires no application code.
- For an additional manual/scheduled backup, use `pg_dump`:
  ```bash
  pg_dump "$DATABASE_URL" --format=custom --file=backup-$(date +%F).dump
  ```
- Private documents stored on Cloudinary are retained per Cloudinary's own
  durability guarantees; if using the local-disk fallback in a
  non-production environment, back up `private-storage/` separately (it is
  git-ignored and not backed up by version control).

## Legal Content

All legal documents (Rental Agreement, Terms & Conditions, Privacy Policy,
Cancellation Policy, Insurance Policy, Damage Policy, Security Deposit
Policy) are stored in the `LegalDocument` table, editable at
`/admin/legal`, and rendered publicly at `/legal/[type]`.

**Every seeded document is placeholder text flagged
`needsAttorneyReview: true`.** This flag renders a visible warning banner on
both the public legal pages and the admin editor. **Do not remove this flag
or accept real bookings/payments until a licensed Texas attorney has
reviewed and approved final language for each document.**

## Production Checklist

- [ ] Real Stripe live keys configured; webhook endpoint verified receiving events
- [ ] Resend sending domain verified; `EMAIL_FROM` matches a verified address
- [ ] Cloudinary configured for both vehicle photos and private document storage
- [ ] `AUTH_SECRET` set to a strong, unique value (`openssl rand -base64 32`)
- [ ] Production `DATABASE_URL` points at a managed, backed-up Postgres instance
- [ ] `npx prisma migrate deploy` run against production database
- [ ] Demo admin/customer seed accounts removed or disabled in production (sign-in is passwordless email-code — see Authentication)
- [ ] `CRON_SECRET` set and all five financial workers scheduled and monitored; see [financial operations](docs/financial-operations.md). `vercel.json` supplies minute schedules for Vercel; other hosts need equivalent authenticated invocations.
- [ ] Demo/sample vehicles replaced with real inventory in `/admin/vehicles`
- [ ] All legal documents reviewed and approved by a licensed Texas attorney; `needsAttorneyReview` cleared
- [ ] Business settings (`/admin/settings`) filled in with real phone/email/hours/tax rate/deposit/minimum age
- [ ] Both domains configured per [Domain Configuration](#domain-configuration); secondary domain 301s verified
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` all pass
- [ ] Responsive layouts spot-checked at 375/390/430/768/1024/1440px
- [ ] Google Analytics 4 / Search Console / Meta Pixel IDs added once consent handling is finalized
- [ ] Twilio SMS left disabled until a consent flow is implemented (architecture only, per project scope)
