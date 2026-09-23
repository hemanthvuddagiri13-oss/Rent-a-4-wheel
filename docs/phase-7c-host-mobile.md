# Phase 7C: host native application

Base: approved main f5d362c4d8f4c68f0bf01381c35c291c1c68f8dc. Draft implementation; verification results must be read from exact-SHA CI, not inferred from this document.

## Architecture

The Expo/React Native source under apps/customer builds two separate identities. EXPO_PUBLIC_APP_MODE=host selects Rent A 4Wheel Host, com.renta4wheel.host and renta4wheel-host; customer remains the default. This deliberately shares the generated versioned client, secure device credentials, serialized refresh, privacy overlay, evidence upload, messaging and recovery screens. Host permissions are checked by the server on every operation, not by the flavor or navigation. No new migration or schema is required.

Six minimal operations add host context, scoped listing details, bounded calendar reads, existing availability commands and identity comparison. Existing report, conversation, case and trip operations are reused. Read-only calendar uses POST for its typed bounded date request and has no mutation receipt. All host writes retain domain reservation/vehicle locks and receipt idempotency. Reservation/vehicle locks precede the actor User lock; membership removal uses that same User lock. Owners alone see earnings. STAFF may inspect calendar but cannot manage it; MANAGER follows existing management permissions.

Hosts are independent providers responsible for storage, maintenance and physical handoffs. The app cannot start a customer trip, resolve financial review or independently release deposits. Return completion calls the existing shared settlement/deposit-recovery policy. Listing creation/approval, host onboarding and employee invitations remain explicitly web-only with unavailable explanations rather than invented native actions.

## Evidence privacy

Identity comparison and condition screens prevent screen capture. Private previews obtain fresh bearer/session/tenant/quarantine authorization, keep bytes in memory and clear on blur, background or after 30 seconds. Downloads recheck current authorization and object identity after storage IO. Nothing creates public private-document URLs. Native screenshot commands omit evidence screens. Synthetic acceptance uses color tiles, never licenses, selfies or real customer data. OS/device compromise and previously viewed human information cannot be revoked retroactively.

## Android system bars

The Phase 7B screenshot showed clipped status glyphs at the native header boundary. Android now uses an explicit safe-area header with light system icons; scroll content includes bottom/landscape safe-area insets. No edge-to-edge opt-out or hidden system navigation. Actual final screenshots must verify the result; code alone is not visual evidence. Sources: https://docs.expo.dev/develop/user-interface/system-bars/ and https://docs.expo.dev/develop/user-interface/safe-areas/.

## Interrupted reply recovery

A pending reply freezes its original body and optimistic version until acknowledged, including after refreshing case state. Its unchanged request fingerprint retains the original idempotency key. No message text is persisted outside the current screen. The PostgreSQL/HTTP test executes a real reply, discards its response after commit, refreshes the case and replays the same request; it asserts one event/receipt. Installed host acceptance uses a CI-only loopback proxy to drop one committed reply and upload response. This establishes recovery for that specific failure window, not the root cause of the earlier unexplained Phase 7B iOS timeout. Safe backend request timing/status telemetry is retained for diagnosis without bodies or credentials.

## Acceptance boundaries

Host native workflow builds release APK and ad-hoc signed iOS simulator app against real Next.js/PostgreSQL. Synthetic fixtures are restricted to CI and disposable `_test` databases. SMS and ClamAV protocol responses are explicit fixtures; no real SMS, live provider payment, payout or production scanning approval is claimed. Storage and database writes are real. Owner/employee/revoked/unrelated sessions use the installed app. Revocation is performed externally between journeys without logging the employee out. Customer return evidence is seeded separately: a host cannot perform customer acceptance. Native journeys and PostgreSQL tests are complementary and must be reported separately.

Production remains blocked on reviewed jurisdiction, insurance/legal/tax/eligibility/pricing approvals, live provider and scanning/storage acceptance, distribution signing, accessibility/device review and any remaining journey gaps. Live payments and payouts stay disabled. Lost-phone recovery remains review intake only; staff ownership transfer needs its separate security-reviewed batch.
