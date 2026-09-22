# Phase 6 UX baseline audit

Approved application: `82bfea4648d86386a1b4be51c76935512bacd0f1`. This audit precedes UI implementation. The dedicated baseline workflow checks out that exact application revision and copies only the observation test into it. No application source is replaced by a mock UI.

## Evidence status

The approved baseline succeeded with 378 captures; its exact evidence is recorded below. Initial fixture failures and subsequent candidate failures are retained in Actions history. Final acceptance is tracked separately from this before-implementation audit.

The baseline uses a dedicated disposable PostgreSQL database, synthetic people/listings and explicitly synthetic jurisdiction approvals. No actual license, selfie, owner document, payment credential or provider payload is present. Private-media selectors are masked in screenshots. Browser sessions are real database-backed sessions; the baseline intentionally injects fixture session cookies for observation, not as proof of the email-code sign-in journey.

Requested capture sizes: 375×812, 390×844, 430×932, 768×1024, 1024×768, 1440×1000. The observation records response status, H1/main landmarks, unlabeled fields, sub-44px interactive targets and page overflow without pretending these heuristics are a WCAG audit.

## Prioritized source findings

| Priority | Finding and evidence | Required correction |
| --- | --- | --- |
| P1 | Root metadata and JSON-LD describe a Dallas rental branch and publish a placeholder telephone. Homepage hero repeats two discovery actions and uses “Drive More. Pay Less.” instead of the requested tagline. `src/app/layout.tsx`, `components/home/hero.tsx`. | Original nationwide marketplace wording, exact brand tagline, no placeholder business claim, one clear search-led primary action. State availability must still come from the jurisdiction engine. |
| P1 | Public navigation has no coherent signed-in customer/host entry. HostNav, FinanceWorkspace, admin layout and account links form disconnected navigation systems. | Responsive role-appropriate navigation with current-route indication and clear customer, host, support and authorized operations entry points. |
| P1 | DocumentUpload hides its only file input with `display:none`, offers no camera/preview/retake, and paints a completion check from a local “uploaded” boolean. | Keyboard-accessible image picker and camera option, preview/retake, bounded upload progress, explicit uploaded/quarantined/review states with no approval implication. |
| P1 | Booking summary is confined to selected steps. All seven steps sit in a horizontally scrolling strip; resume failures show only a status paragraph. | Persistent authoritative summary, compact mobile progress, actionable resume/hold-expiry/error states, safe retry and preserved finalized checkout identity. |
| P1 | Payment errors are unannounced paragraphs. Historical-ineligible responses are collapsed into generic error text. Deposit recovery wording exposes implementation language. | Explicit current eligibility, announced errors, safe recovery links, clear pending/refund/deposit status and server-only confirmation. |
| P1 | TripConsole combines readiness, identity, multiple inspections and return forms into a long page. Photo controls lack preview/retake and display only private links after submission. | Guided role-specific pickup/return tasks, camera-first evidence controls, truthful saved/pending states, required-photo progress, exact server gate reasons and support access. |
| P1 | Customer account classifies trips primarily by dates; active/completed attention items are not organized as a coherent timeline. | Status-aware trip grouping and one reservation timeline with only currently authorized actions. |
| P1 | Payout schedule returns only `planned`; caught failures/review deferrals can summarize as NO_WORK. Historical payout audit reports only `checked`. | Shared worker results for committed, failed, skipped, review, checked/actionable and explicit nested aggregation; preserve amounts, eligibility and provider movement. |
| P2 | Small buttons are 36px and icon buttons 40px. Vehicle pricing captions use 10px text. Radix filter triggers have visual labels without explicit associations. | 44px design targets, readable labels, programmatic names and keyboard/focus checks. |
| P2 | Three separate input/status conventions exist: UI primitives, workspace-input/ActionForm and finance/trip status strings. Gold gradients and gold status text are overused. | Semantic tokens and shared accessible controls/status language; restrained gold for primary actions and focus. |
| P2 | Search no-results text suggests recovery but offers no direct reset. Sorting is desktop-only. Public/account/booking route groups lack dedicated loading/error states. | Active filter chips, mobile sorting, actual reset/recovery actions and consistent route loading/error/empty states. |
| P2 | Host dashboard emphasizes counts; due returns, unresolved documents, maintenance and messages need actionable prioritization. | Server-derived action queue and responsive fleet/calendar presentation. |
| P2 | Admin navigation is a long horizontal strip on small screens. Review forms expose raw status terminology and repeated verification patterns. | Grouped mobile navigation, readable status labels, standard reason/confirmation/step-up patterns and clear queue filters. |
| P2 | Public host profile is not a dedicated route in the approved application. | Add an approved-public-data profile with legitimate published feedback and current visibility checks. |

These are implementation targets, not permission to bypass backend policy. Professional policy text remains editable and unapproved where applicable. No real insurance, fee advantage, verification or payout promise may be invented.

## Current navigation and component inventory

Public chrome: Navbar → page → Footer. Admin chrome: separate sidebar/header/main. Authenticated marketplace pages reuse Workspace/Panel inconsistently with customer Card/Badge and finance-specific wrappers. Shared UI primitives currently include button, input, textarea, select, checkbox, card, badge, dialog, sheet, tabs, accordion, skeleton and progress. Missing coherent primitives include field descriptions/validation, searchable combobox, radio/switch, breadcrumb, mobile action bar, media capture, state panels and responsive data tables.

ActionForm already supplies real fetch, pending state, inline status and current service endpoints; it should be improved rather than replaced with fake interactions. Booking/time, financial projection, storage access and trip services remain authoritative.

## Route and role inventory

Roles below describe the page family entry point. Per-record tenant checks and per-action capability/step-up checks remain authoritative; a visible navigation link is never authorization.

| Route | Primary users / authority | Source |
| --- | --- | --- |
| `/account` | Current customer / reservation owner | `src/app/account/page.tsx` |
| `/account/reservations/[id]` | Current customer / reservation owner | `src/app/account/reservations/[id]/page.tsx` |
| `/account/security` | Current customer / reservation owner | `src/app/account/security/page.tsx` |
| `/admin/calendar` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/calendar/page.tsx` |
| `/admin/coupons/new` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/coupons/new/page.tsx` |
| `/admin/coupons` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/coupons/page.tsx` |
| `/admin/faq` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/faq/page.tsx` |
| `/admin/financial-cases` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/financial-cases/page.tsx` |
| `/admin/legal` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/legal/page.tsx` |
| `/admin/maintenance/new` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/maintenance/new/page.tsx` |
| `/admin/maintenance` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/maintenance/page.tsx` |
| `/admin/marketplace` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/marketplace/page.tsx` |
| `/admin/marketplace/vehicles/[id]` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/marketplace/vehicles/[id]/page.tsx` |
| `/admin/operations` | SUPER_ADMIN | `src/app/admin/operations/page.tsx` |
| `/admin/owners/new` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/owners/new/page.tsx` |
| `/admin/owners` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/owners/page.tsx` |
| `/admin` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/page.tsx` |
| `/admin/reservations/[id]` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/reservations/[id]/page.tsx` |
| `/admin/reservations` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/reservations/page.tsx` |
| `/admin/reviews` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/reviews/page.tsx` |
| `/admin/settings` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/settings/page.tsx` |
| `/admin/vehicles/[id]` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/vehicles/[id]/page.tsx` |
| `/admin/vehicles/new` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/vehicles/new/page.tsx` |
| `/admin/vehicles` | STAFF, ADMIN, SUPER_ADMIN; page/action restrictions | `src/app/admin/vehicles/page.tsx` |
| `/book/[vehicleId]` | Current customer / reservation owner | `src/app/book/[vehicleId]/page.tsx` |
| `/connect/cases/[id]` | Current participant or scoped SUPPORT/CLAIMS/finance operator | `src/app/connect/cases/[id]/page.tsx` |
| `/connect/conversations/[id]` | Current participant or scoped SUPPORT/CLAIMS/finance operator | `src/app/connect/conversations/[id]/page.tsx` |
| `/connect` | Current participant or scoped SUPPORT/CLAIMS/finance operator | `src/app/connect/page.tsx` |
| `/contact` | Public visitor; approved inventory/policy visibility | `src/app/contact/page.tsx` |
| `/faq` | Public visitor; approved inventory/policy visibility | `src/app/faq/page.tsx` |
| `/finance/admin` | FINANCE_AGENT, ADMIN, SUPER_ADMIN; action restrictions | `src/app/finance/admin/page.tsx` |
| `/finance/admin/reconciliation` | FINANCE_AGENT, ADMIN, SUPER_ADMIN; action restrictions | `src/app/finance/admin/reconciliation/page.tsx` |
| `/finance/admin/rules` | FINANCE_AGENT, ADMIN, SUPER_ADMIN; action restrictions | `src/app/finance/admin/rules/page.tsx` |
| `/finance/onboarding` | Current host/finance grant; customer statements by ownership | `src/app/finance/onboarding/page.tsx` |
| `/finance` | Current host/finance grant; customer statements by ownership | `src/app/finance/page.tsx` |
| `/finance/payouts/[id]` | Current host/finance grant; customer statements by ownership | `src/app/finance/payouts/[id]/page.tsx` |
| `/finance/statements` | Current host/finance grant; customer statements by ownership | `src/app/finance/statements/page.tsx` |
| `/host` | Host owner/current employee; role and tenant scope | `src/app/host/page.tsx` |
| `/host/profile` | Host owner/current employee; role and tenant scope | `src/app/host/profile/page.tsx` |
| `/host/reservations/[id]` | Host owner/current employee; role and tenant scope | `src/app/host/reservations/[id]/page.tsx` |
| `/host/reservations` | Host owner/current employee; role and tenant scope | `src/app/host/reservations/page.tsx` |
| `/host/team` | Host owner/current employee; role and tenant scope | `src/app/host/team/page.tsx` |
| `/host/vehicles/[id]` | Host owner/current employee; role and tenant scope | `src/app/host/vehicles/[id]/page.tsx` |
| `/host/vehicles/new` | Host owner/current employee; role and tenant scope | `src/app/host/vehicles/new/page.tsx` |
| `/host/vehicles` | Host owner/current employee; role and tenant scope | `src/app/host/vehicles/page.tsx` |
| `/how-it-works` | Public visitor; approved inventory/policy visibility | `src/app/how-it-works/page.tsx` |
| `/legal/[type]` | Public visitor; approved inventory/policy visibility | `src/app/legal/[type]/page.tsx` |
| `/long-term-rentals` | Public visitor; approved inventory/policy visibility | `src/app/long-term-rentals/page.tsx` |
| `/` | Public visitor; approved inventory/policy visibility | `src/app/page.tsx` |
| `/sign-in` | Public visitor; approved inventory/policy visibility | `src/app/sign-in/page.tsx` |
| `/sign-up` | Public visitor; approved inventory/policy visibility | `src/app/sign-up/page.tsx` |
| `/vehicles/[slug]` | Public visitor; approved inventory/policy visibility | `src/app/vehicles/[slug]/page.tsx` |
| `/vehicles` | Public visitor; approved inventory/policy visibility | `src/app/vehicles/page.tsx` |

The `/connect` views include inbox, notifications, reviews, support, cases and scoped customer reputation. Baseline captures include the four primary view variants plus every stored account role. The final route coverage matrix must map actual journey/state assertions to these routes, not count screenshots as journey proof.

## HTTP route inventory

Boundaries are carried forward from [Phase 5 inventory](PHASE5_INVENTORY.md). Machine routes retain signature/secret checks; user routes retain full database session, origin, scope and transactional business checks.

| Route | Boundary family |
| --- | --- |
| `/api/account/profile` | Current account and device session |
| `/api/account/security` | Current account and device session |
| `/api/admin/marketplace` | Current administrative capability and per-action step-up |
| `/api/admin/operations` | Current administrative capability and per-action step-up |
| `/api/admin/reservations/[id]/emergency-override` | Current administrative capability and per-action step-up |
| `/api/admin/reservations/[id]/return-review` | Current administrative capability and per-action step-up |
| `/api/auth/[...nextauth]` | Public code/session entry; purpose/attempt/rate and database session authority |
| `/api/auth/request-code` | Public code/session entry; purpose/attempt/rate and database session authority |
| `/api/community/cases/[id]/photos/[photoId]` | Current participant/operator; resource and scan gates |
| `/api/community/files/[id]` | Current participant/operator; resource and scan gates |
| `/api/community/notices/[id]` | Current participant/operator; resource and scan gates |
| `/api/community` | Current participant/operator; resource and scan gates |
| `/api/community/sms` | Current participant/operator; resource and scan gates |
| `/api/contact` | Public bounded input / current route-specific authority |
| `/api/cron/community` | CRON_SECRET and worker allowlist |
| `/api/cron/expire-holds` | CRON_SECRET and worker allowlist |
| `/api/cron/financial/[worker]` | CRON_SECRET and worker allowlist |
| `/api/cron/operations/[worker]` | CRON_SECRET and worker allowlist |
| `/api/cron/payouts/[worker]` | CRON_SECRET and worker allowlist |
| `/api/documents/[id]` | Current owner/reviewer, quarantine and private storage |
| `/api/documents/upload` | Current owner/reviewer, quarantine and private storage |
| `/api/finance/documents/[id]` | Current finance/host/customer scope and financial service authority |
| `/api/finance/export` | Current finance/host/customer scope and financial service authority |
| `/api/finance` | Current finance/host/customer scope and financial service authority |
| `/api/health/live` | Sanitized public health |
| `/api/health/ready` | Sanitized public health |
| `/api/host/files` | Current host tenant and employee/owner capability |
| `/api/host/reservations` | Current host tenant and employee/owner capability |
| `/api/host/vehicles/[id]/agreement` | Current host tenant and employee/owner capability |
| `/api/host/vehicles` | Current host tenant and employee/owner capability |
| `/api/host/workspace` | Current host tenant and employee/owner capability |
| `/api/marketplace/files/[id]` | Approved public listing photo or current private business-file scope |
| `/api/reservations/[id]/agreement` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/cancel` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/checkout` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/condition-reports/[reportId]/accept` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/condition-reports` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/confirm-dev-payment` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/experience` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/identity-handoff` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/payment-intent` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/photos/[photoId]` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/receipt` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/resume` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/retry-deposit` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/start-trip` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/status` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/[id]/trip-start-gate` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations/hold` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/reservations` | Current customer/participant; locked reservation/financial/jurisdiction state |
| `/api/vehicles/[id]/quote` | Public authoritative visible-vehicle quote |
| `/api/webhooks/stripe` | Provider signature, durable receipt and fencing |

## Before implementation / final acceptance distinction

Baseline observation artifacts are generated by `.github/workflows/phase6-baseline.yml`. Final acceptance must additionally run all 20 requested real journeys, automated accessibility checks, manual keyboard assertions, 200% zoom, reduced-motion and every requested viewport. Lighthouse values must be measured on representative public and authenticated routes. No scores or screenshot-review completion are claimed here.


## Captured baseline evidence — 22 September 2026

The approved-application baseline completed successfully in [CI run 35692507729](https://github.com/hemanthvuddagiri13-oss/Rent-a-4-wheel/actions/runs/35692507729). Artifact `phase6-approved-baseline` (ID 10678598285) contains 378 screenshots, a manifest and an HTML gallery: 63 route/role views at six sizes. Every observed response was HTTP 200. Application source was pinned to `82bfea4648d86386a1b4be51c76935512bacd0f1`; harness commit was `2c6ea6bfa5251fa5d797a25a69acf67312d30171`.

Measured document overflow occurred on account at 375; admin legal at 375/390; admin dashboard at 1024; booking at 768; staff account at 375/1024; and administrator account at 1024. FAQ had one unlabeled field at every size. These DOM heuristics are findings, not a WCAG audit. A response of 200 is not evidence that the requested workflow works.

Initial visual review of account, reservation, security, calendar, coupon, FAQ administration, financial cases, legal, maintenance, marketplace review, release controls and owner screens confirms clipped legal action labels, crowded account reservation cards, long unstructured trip forms, dense administrative navigation, empty tables whose message scrolls out of view, and inconsistent native versus designed form controls. Review of the remaining screenshot gallery is still pending; no complete visual acceptance is claimed.

The shared-control correction starts with wrapping action labels, 44px controls, legible form text, restrained gold actions, neutral secondary actions, visible dialog-close focus and scrollable safe-area-aware drawers. Dedicated browser checks must verify these changes after implementation.

## Correction mapping

| Baseline priority / concern | Implementation |
| --- | --- |
| P1 brand and branch claims | Original marketplace metadata, exact tagline, search-led hero, independent-host wording, no default placeholder contact or unsupported discount/maintenance promise. |
| P1 disconnected navigation | Current-role navbar, grouped admin and shared workspace navigation, current-route indicators. Authorization stays on destination/action. |
| P1 upload approval confusion | Accessible camera/file inputs, local preview/retake, progress, explicit scan/review states and quarantine journey. |
| P1 booking continuity | Persistent summary, compact progress, server expiration countdown, recovery links and preserved immutable checkout identity. |
| P1 financial status | Announced errors, authoritative polling, deposit-required distinction, historical eligibility, neutral pending confirmation and compensation journey. |
| P1 trip form | Role-specific pickup/return checklist, selected-photo progress, server-saved reports, timestamps/attribution and trip support. Retained previews intentionally use secure download alternative. |
| P1 account grouping | Status-aware attention/active/upcoming/past grouping and reservation timeline. |
| P1 worker reporting | Shared nested worker results for scheduling, reconciliation and historical audit; caught failures and all-review batches remain actionable. Per-account report errors do not substitute totals. |
| P2 touch targets / labels | Shared 44px button targets, wrapping labels, readable pricing text and associated filter labels; exact-width axe audit. |
| P2 inconsistent controls | Shared semantic tokens, workspace fields, neutral secondary/status styling and protected loading/retry feedback. |
| P2 discovery / loading | Mobile sorting, active filters, clear reset, date errors, search-only loading boundary, account/booking loading and error boundaries. Detail rejection preserves non-streamed 404. |
| P2 host action priorities | Server-derived return/vehicle-attention queues, pickup list and direct documents, messages, claims and earnings access. |
| P2 admin navigation / statuses | Grouped mobile navigation, readable status presentation, existing reason/step-up safeguards and queue filters retained. |
| P2 public host route | Current approved host and visible vehicle projection, published feedback only, no legal-name/contact/private-file projection. |

Seven recorded candidate overflow observations were addressed through actual flex/grid minimums and wrapping: dashboard/chart containers at 1024, administrator dashboard at 375, vehicle edit heading/actions at 375, booking vehicle card at 768 and homepage hero at 375 (including separate STAFF/ADMIN observations). A subsequent exact-application audit at fead467447195d12b28da25ce06961ce75fc62a0 recorded 384 captures with zero document overflow, zero axe violations and zero browser console errors. Its separate zoom/focus checks failed; those failures are not counted as acceptance.

See PHASE6_JOURNEYS.md for the complete 20-journey assertion map. Final exact-SHA verification and visual review remain mandatory before marking Phase 6 complete.

## Visual inspection follow-up

The 041c4ab route/role gallery was inspected across all six widths. Despite zero document overflow and axe violations, visual inspection found split Search labels in community forms, small native account-security and release actions, and the maintenance empty message outside the initial table viewport. These were corrected with non-shrinking search actions, shared buttons, labeled full-size security fields and an empty state outside the scroll table. Financial-case forms now use the shared field and action styles. Recorded focus states remain a separate review requirement.
