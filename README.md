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
- **Auth:** Auth.js (NextAuth v5) — credentials provider, JWT sessions, role-based access
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
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Bootstrap admin login used by `npm run db:seed` |

**Development without credentials:** Stripe, Resend, and Cloudinary all
degrade gracefully when their keys are missing:

- **Stripe absent** → the booking payment step shows a clearly labeled
  "Development Mode" panel with a **Simulate Successful Payment** button, so
  the full booking flow (through confirmation + PDF agreement) can be tested
  end to end. This simulate-payment endpoint refuses to run once real Stripe
  keys are present.
- **Resend absent** → emails are logged to the server console instead of
  sent, and `Notification` rows are still recorded with a `FAILED` status
  and an explanatory error message.
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
users/auth, vehicles, images, features, ownership, reservations, extras,
payments, refunds, security deposits, driver documents, rental agreements,
fleet operations (blocks, inspections, damage reports, maintenance),
coupons, reviews, contact messages, FAQ, notifications, audit logs, and
admin-editable site settings.

## Seeding Demo Data

```bash
npm run db:seed
```

Seeds:
- 10 **sample** vehicles (clearly flagged `isDemo: true`) across Economy,
  Sedan, SUV, Luxury, and Truck categories, with placeholder imagery
  (`public/images/vehicles/*.svg`) — **not real inventory**.
- An admin account (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, default
  `admin@renta4wheel.com` / `ChangeMe123!` — change this immediately).
- A demo customer account (`demo.customer@example.com` / `Demo1234!`).
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

The availability/booking tests are integration tests that run against a
real PostgreSQL database (`DATABASE_URL`) and clean up every row they
create. Payment-webhook and full booking-API behavior were also verified
manually end-to-end (see the PR/commit history) — expanding those into
automated integration tests (spinning up the Next.js server + mocked Stripe
events) is a natural next addition.

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
- [ ] Admin account created with a strong password; demo admin/customer accounts removed or disabled
- [ ] Demo/sample vehicles replaced with real inventory in `/admin/vehicles`
- [ ] All legal documents reviewed and approved by a licensed Texas attorney; `needsAttorneyReview` cleared
- [ ] Business settings (`/admin/settings`) filled in with real phone/email/hours/tax rate/deposit/minimum age
- [ ] Both domains configured per [Domain Configuration](#domain-configuration); secondary domain 301s verified
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` all pass
- [ ] Responsive layouts spot-checked at 375/390/430/768/1024/1440px
- [ ] Google Analytics 4 / Search Console / Meta Pixel IDs added once consent handling is finalized
- [ ] Twilio SMS left disabled until a consent flow is implemented (architecture only, per project scope)
