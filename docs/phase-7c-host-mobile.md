# Phase 7C: host native application

Base: approved main f5d362c4d8f4c68f0bf01381c35c291c1c68f8dc. Draft implementation; verification results must be read from exact-SHA CI, not inferred from this document.

## Architecture

The Expo/React Native source under apps/customer builds two separate identities. EXPO_PUBLIC_APP_MODE=host selects Rent A 4Wheel Host, com.renta4wheel.host and renta4wheel-host; customer remains the default. This deliberately shares the generated versioned client, secure device credentials, serialized refresh, privacy overlay, evidence upload, messaging and recovery screens. Host permissions are checked by the server on every operation, not by the flavor or navigation. No new migration or schema is required.

Six minimal operations add host context, scoped listing details, bounded calendar reads, existing availability commands and identity comparison. Existing report, conversation, case and trip operations are reused. Read-only calendar uses POST for its typed bounded date request and has no mutation receipt. All host writes retain domain reservation/vehicle locks and receipt idempotency. Reservation/vehicle locks precede the actor User lock; membership removal uses that same User lock. Owners alone see earnings. STAFF may inspect calendar but cannot manage it; MANAGER follows existing management permissions.

Hosts are independent providers responsible for storage, maintenance and physical handoffs. The app cannot start a customer trip, resolve financial review or independently release deposits. Return completion calls the existing shared settlement/deposit-recovery policy. Listing creation/approval, host onboarding and employee invitations remain explicitly web-only with unavailable explanations rather than invented native actions.

## Evidence privacy

Identity comparison and condition screens prevent screen capture. Mounted protected components share one reference-counted native capture lock. Acquire/release transitions are serialized, content stays hidden until protection is acknowledged, and removing one preview cannot unlock another protected screen. This avoids repeated iOS window reparenting by the bundled Expo native implementation; uncertain native failures keep private views unavailable until restart. Private previews obtain fresh bearer/session/tenant/quarantine authorization, keep bytes in memory and clear on blur, background or after 30 seconds. Downloads recheck current authorization and object identity after storage IO. Nothing creates public private-document URLs. Native screenshot commands omit evidence screens. Synthetic acceptance uses color tiles, never licenses, selfies or real customer data. OS/device compromise and previously viewed human information cannot be revoked retroactively.

## Android system bars

The Phase 7B screenshot showed clipped status glyphs at the native header boundary. Android now uses an explicit safe-area header with light system icons; the scroll viewport excludes bottom/landscape safe-area insets. No edge-to-edge opt-out or hidden system navigation. Actual final screenshots must verify the result; code alone is not visual evidence. Sources: https://docs.expo.dev/develop/user-interface/system-bars/ and https://docs.expo.dev/develop/user-interface/safe-areas/.

## Interrupted reply recovery

A pending reply freezes its original body and optimistic version until acknowledged, including after refreshing case state. Its unchanged request fingerprint retains the original idempotency key. No message text is persisted outside the current screen. The PostgreSQL/HTTP test executes a real reply, discards its response after commit, refreshes the case and replays the same request; it asserts one event/receipt. Installed host acceptance uses a CI-only loopback proxy to truncate one committed reply and upload response body. This establishes recovery for that specific failure window, not the root cause of the earlier unexplained Phase 7B iOS timeout. Safe backend request timing/status telemetry is retained for diagnosis without bodies or credentials.

## Acceptance boundaries

Host native workflow builds release APK and ad-hoc signed iOS simulator app against real Next.js/PostgreSQL. Synthetic fixtures are restricted to CI and disposable `_test` databases. SMS and ClamAV protocol responses are explicit fixtures; no real SMS, live provider payment, payout or production scanning approval is claimed. Storage and database writes are real. Owner/employee/revoked/unrelated sessions use the installed app. Revocation is performed externally between journeys without logging the employee out. Customer return evidence is seeded separately: a host cannot perform customer acceptance. Native journeys and PostgreSQL tests are complementary and must be reported separately. Native keys and completion actions include double taps, with database assertions for one checklist and one event per committed action. Calendar status tests use independent reservations so the test setup itself never reverses a cancellation. The installed release apps use a real Next.js development server for fixture acceptance; the production web build is verified separately.

Production remains blocked on reviewed jurisdiction, insurance/legal/tax/eligibility/pricing approvals, live provider and scanning/storage acceptance, distribution signing, accessibility/device review and any remaining journey gaps. Live payments and payouts stay disabled. Lost-phone recovery remains review intake only; staff ownership transfer needs its separate security-reviewed batch.

## iOS CI input and readiness evidence

At 500539d, the host retry stopped before SMS: Maestro injected `+` but dropped its remaining burst. Phone input now checks each native field prefix before injecting the next character on iOS; Android keeps its original full-string input and both assert the complete number. This is synchronization with observed field state, not a skipped assertion or a claim about physical-keyboard speed. Maestro TextInputHelper itself documents dropped characters after first-character injection.

The customer retry recorded native SecItemAdd at 18:57:20 and resumed at 18:58:09, before sign-in HTTP (315ms) completed. iOS authentication checks now await the actual authenticated screen with a 75s upper bound covering this measured 49s cold Keychain delay plus the existing 20s HTTP bound. No fixed sleep, credential-storage downgrade, or server authority change is used. This simulator latency still requires physical-device validation. A separate first-attempt final logout tap had no corresponding HTTP request; the journey now resolves its target through scrollUntilVisible to stabilize the native hierarchy before tapping, as the earlier successful logout already did.


### Host iOS driver investigation (f0f9d4d)

Run 35907285385 failed twice in the XCTest driver. Attempt 1 failed SpringBoard snapshot acquisition before app launch. Attempt 2 reached the support case after owner sign-in, calendar, messaging and handoff checks, then XCTest reported kAXErrorInvalidUIElement while resolving status bars. Its HTTP server terminated; Maestro subsequently reported DeviceUnreachableException on port 51249. The app remained on the case screen and captured API operations succeeded. This is driver failure evidence, not proof of the remaining journeys.

The correction pins Maestro 2.10.0 with its release SHA-256 and Xcode 26.6, creates a fresh iPhone 17 Pro on exactly iOS 26.5 (the matching SDK), and rejects missing/ambiguous runtimes. Each driver command has a 20-minute process deadline so hung drivers fail while diagnostics can still be uploaded. No journey assertion, authorization or financial gate is removed or relaxed. Exact-commit installed-app results are required before treating this setup as verified.

Run 35920662376 at 0d393b5 completed iOS support recovery, interrupted upload and return without the prior XCTest crash. It stopped at a premature keys-result assertion: tripKeys returned 200 at 21:48:15, authoritative readback completed at 21:48:25, and the 21:48:31 failure screenshot already showed Keys handoff recorded. The harness now awaits an enabled gate before repeated taps and the exact recorded state afterward, bounded by the three existing 20-second HTTP stages (me, mutation, parallel readback); it retains the result assertion and database uniqueness checks.

The automatically triggered customer iOS run 35920662454 also exposed an edge-position navigation tap: Account was targeted at y=819 on an 874-point screen but never opened. Its test now centers the target and asserts Login & recovery before looking for logout. Both app flavors use the same pinned simulator toolchain; no application behavior or assertions are removed.

Screenshot review additionally found that the message assertion could match composer text and the recovered-reply capture could precede retry acknowledgement. Acceptance now awaits the initially empty conversation becoming nonempty and the pending-reply state clearing, preserving the exact body and single-event database assertions.
