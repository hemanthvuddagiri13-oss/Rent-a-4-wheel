# Phase 6 browser acceptance map

All journeys run against Next.js HTTP routes and disposable PostgreSQL. Test names below identify executable assertions; passing status must be taken from the exact final SHA's Actions logs, never inferred from screenshots. All provider substitutes are confined to test fixtures. The standalone mocked booking UI test is excluded from this map.

| # | Journey | Executable evidence | Assertions / controlled boundary |
| --- | --- | --- | --- |
| 1 | Visitor searches and views a vehicle | marketplace-browser: discovery and account pages | Anonymous visitor submits real make filters at all six widths, sees one matching listing, follows its detail link. |
| 2 | Customer email-code sign-in | marketplace-browser: controlled email-code UI | Real issuance, hashed code consumption, Auth.js and one database session; local test email boundary only. |
| 3 | Booking completion | booking-real-server: Chicago instants / Back / reload / Stripe return | Real hold, immutable checkout, uploads, agreement and explicitly enabled development payment simulator; one successful rental payment, durable reservation and cleared expiration. No intercepted booking success. |
| 4 | Identity upload and truthful status | marketplace-browser: checkout/resume; identity camera/file flow | Real upload route/storage/scanner protocol; camera input, scan state and no implied approval. Synthetic solid-color media only. |
| 5 | Host onboarding and vehicle creation | marketplace-browser: host onboarding/listing/owner/calendar | Explicit synthetic staging jurisdiction admission; profile submitted, inactive pending listing, real date block and owner/employee operations. |
| 6 | Administrator host/vehicle review | marketplace-browser: host onboarding/listing/owner/calendar | Real administrative review and permission checks; unreviewed agreement rejected. |
| 7 | Customer/host messaging | community-browser: customer-host messaging | Real reciprocal messages, private attachment and notification-read persistence. |
| 8 | Host pickup checklist/photos | marketplace-browser: inspection/handoff/start/return | Real identity handoff and photo submissions; unauthorized customer identity assertion rejected. Upstream payment and identity approvals are explicit persisted fixtures. |
| 9 | Customer condition confirmation/trip start | same inspection journey | Server refuses premature start; both reports accepted and keys released before real start changes status to ACTIVE. |
| 10 | Customer return | same inspection journey | Real begin-return action and required return report/photos. |
| 11 | Host return inspection | same inspection journey | Real host report and return review; COMPLETED persisted, owner receipt succeeds and outsider denied. |
| 12 | Claim/dispute/support | community-browser: claim, dispute and roadside/support tests | Both parties, claims and support agents; decision history retained, safety block applied, financial review preserved and no money operation created by claim resolution. |
| 13 | Mutual reviews | community-browser: mutual post-trip reviews | Blind period, controlled publication deadline and no public customer-reputation leakage. |
| 14 | Host earnings | finance-browser: private earnings | Real earnings and Connect-status pages; disabled provider configuration returns 409, customer cannot see host finance. |
| 15 | Operations and finance queues | marketplace-browser: operations dashboard; finance-browser: draft rules/reconciliation | Real privileged pages, unapproved rules, reconciliation cases; malformed account time zone cannot crash every account report. |
| 16 | Session revocation | marketplace-browser: session revocation/security | Real device revoke invalidates other session, origin check rejects cross-origin action, customer denied operations. |
| 17 | Hold expiration/recovery | marketplace-browser: expired checkout hold | Expired server hold blocks payment creation and offers recovery to search; no payment row created. |
| 18 | Processing/failure/compensation | marketplace-browser: real payment status UI | Persisted synthetic provider observations drive real status polling; pending/refunded cancellation cannot start a trip, payment remains singular. Provider crash windows remain covered by financial suites. |
| 19 | Scanner unavailable/quarantine | marketplace-browser: identity camera/file flow | Controlled scanner ERROR, real upload, QUARANTINED persisted and shown; no clean/approved claim. |
| 20 | Disabled jurisdiction | marketplace-browser: disabled jurisdiction | Hidden search, detail 404 and denied quote; no production jurisdiction approval. |

Customer, host, host employee, administrator, support agent, claims agent and finance agent are represented across behavioral tests and the route audit. Employee grant/revocation is exercised by the onboarding journey, not inferred from a navigation screenshot.

## Visual and accessibility evidence

`phase6-acceptance.test.ts` enumerates every page route plus community views and role variants, recording route, role, viewport, scenario, HTTP status, overflow, axe violations and console errors. Six viewports: 375×812, 390×844, 430×932, 768×1024, 1024×768, 1440×1000. Explicit keyboard assertions cover Enter, Tab containment, Escape and restored visible trigger focus; reduced motion is requested. CSS zoom reflow is recorded separately. These scripted checks are not a human assistive-technology assessment or a WCAG compliance declaration.

The approved baseline is 82bfea4648d86386a1b4be51c76935512bacd0f1 (Actions 35692507729). The candidate workflow produces a browsable before/after gallery, comparison manifest, sanitized PNGs, axe/overflow/console results and measured production-build Lighthouse scores. New routes and zoom scenarios explicitly have no stable baseline. Pixel differences are observations requiring visual review, not an automatic acceptance threshold.

Retained private evidence uses authorized attachment downloads. Local selected-image previews are masked. No retained private evidence is loaded through public image optimization or copied to CI artifacts. Deployed scanner, storage, email and Stripe integration acceptance remains separate from controlled boundary tests.
