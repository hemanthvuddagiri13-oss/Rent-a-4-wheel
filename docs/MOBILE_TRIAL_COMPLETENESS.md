# Private trial functional-completeness inventory

Base: development main f0557d560284127cce2dfc05e088f5f7d8d863bb (PR #11). No UI redesign, migrations, live finance or ownership-transfer approval.

## Journey inventory and authority

| Journey | Existing authority | Remaining gap / batch decision |
| --- | --- | --- |
| Customer/host phone sign-in, email fallback, account linking | mobile/auth, login-identity, auth-code; native device generations | Working with fixtures. Real SMS/email, physical-device reliability and secure staging remain external gates. Original iOS request-code timeout remains unresolved; deadlines and OTP retries unchanged. |
| Lost phone recovery | login-identity, review intake | Ownership transfer intentionally unavailable; separate security-reviewed staff workflow required. |
| Discovery and listing photos | mobile/queries, jurisdiction/release gates, approved marketplace photos | Catalog and per-vehicle date availability work. Date-filtered catalog, location filters and favorites remain gaps. No invented listing ownership. |
| Hold, dates, extras, coupons | checkout-hold, admission locks, checkout-service | Native holds and date selection work; extra/coupon selection UI incomplete. Existing hold fingerprints cannot be mutated by handoff. |
| Identity uploads/recovery | mobile/uploads, scanner, private storage, mutation receipts | Working. This batch exposes existing customer CLEAN image previews; quarantine remains blocked. No public URLs or document disk cache. |
| Agreement review/signing | agreements, frozen acceptance and artifact, legal/jurisdiction gates | Draft review/acceptance in checkout exists. This batch reads frozen signed text and opens the independently authenticated web PDF path. Host access to guest rental PDFs is not added: current approved web policy is customer/reviewer only. |
| Rental payment/deposit | rental-payment, durable provider operations, Stripe handlers, deposit-authorization, financialProjection | Highest priority: ordinary browser handoff to the existing owner-only reservation/payment workflow, no token exchange. Browser sign-in, legal/booking/provider gates remain independent. With no test provider, completion remains unavailable. No native card form or new provider operation. |
| Payment return/status, refunds | financialProjection, existing polling, financial holds | Only server status establishes confirmation. Browser opening/return does not imply success. Refund/admin actions stay web-only. Different-card deposit flow remains an existing domain/UI gap requiring separate design. |
| Customer trip start/return/photos | trip-gate, customer-reservation, report services and locks | Working native flows and durable recovery; preserve all gates. Report photo reads gain the final effective-storage revalidation before bytes. |
| Host pickup instructions/handoff/keys | host-mobile, host-access, marketplace, trip-gate | Working owner/employee workflows; hosts cannot start customer trips. Physical identity comparison remains a human action, not automatic verification. |
| Host fleet/calendar/listing | marketplaceHost and current membership, availability locks | Native calendar/listing read works. Onboarding, listing creation/editing/activation, business-document uploads and host agreements remain web-only. No weak placeholder links added. |
| Messages, support replies/cases | conversations, collaboration-access, service-cases, durable receipts | Working native text and recovery. Attachments, moderation, escalation and full case history tooling remain web-only/incomplete; independent current resource permission is required before adding downloads. |
| Claims/incident evidence | service-cases, accepted report photos, safety/financial holds | Native incident intake with original report-photo references works. Settlement/charges are not native; cannot bypass professional review or financial holds. |
| Reviews | review domain service and version checks | Native submission exists. Browsing/editing/moderation UI remains incomplete. |
| Notices and preferences | inboxNotice, collaboration services | Native list works; read/unread, preference management and push delivery remain gaps. Provider-backed push requires credentials and separate privacy review. |
| Host earnings/payouts | owner-only hostEarnings, immutable ledger and payout gates | Read-only owner earnings work. Statements/export and payout administration remain web-only. Employees receive no owner financial fields; live payouts remain disabled. |
| Private receipts/business/collaboration files | finance documents, business-file-access, case/conversation policies | Existing authenticated web paths remain; native listing/rendering/export are deferred rather than expanding recipient policy implicitly. |
| Device/logout/revocation | mobile credentials, SecureStore, account-scoped purge | Working recovery, revocation and purge. Browser sessions remain independently managed; native logout is not browser logout. |

## Browser boundary

The API returns only a fixed same-origin account path after authenticating the current native customer and reservation ownership. It creates no cookie, capability, payment, session or provider operation. Repeated/interrupted reads are safe; copied URLs have no authority. The app accepts only the configured HTTPS origin (or explicit loopback acceptance) and an allowlisted account-reservation path. The browser must sign in independently; wrong accounts cannot access the reservation. Existing web checkout reuses original durable operations and frozen booking evidence. Native financial polling remains authoritative on return.

Signed PDF links lead to the authenticated account page. The download repeats the captured browser session ID/version, current owner/reviewer policy, exact signed artifact and effective storage checks after provider I/O. No bearer-to-cookie bridge or public storage URL exists. Browsers may retain user-downloaded PDF copies; the app explains this rather than promising remote deletion of exported copies. Native identity previews remain memory-only and close on blur/background/expiry.

## External requirements and unsupported actions

An isolated HTTPS staging backend, approved policies, private storage/scanner, test Stripe/webhooks, email/SMS providers, Android signing and Apple provisioning are still required before a meaningful phone-installed test. Software handoff and authorization tests do not establish real-provider payment/deposit completion. Installed CI apps remain emulator/simulator builds with synthetic users and providers. Do not distribute unsigned artifacts, collect real identity documents or deploy production. Live payments/payouts stay disabled; lost-phone ownership transfer remains review-only.

Verification results will be recorded against the final SHA. This document is an inventory and design statement, not a claim that planned tests already passed.
