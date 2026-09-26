# Private device trial: readiness and limits

Current native CI artifacts are **not installable private-beta builds**. Android acceptance builds target the x86_64 emulator and embed `http://localhost:3000` and synthetic provider settings. iOS acceptance artifacts use the simulator SDK with ad-hoc simulator entitlements; they cannot be installed on a personal iPhone or distributed through TestFlight. The workflows use disposable PostgreSQL and fixture accounts, SMS, scanner and storage boundaries. No persistent staging deployment or signed device distribution is established by those jobs.

The approved Phase 7D merge is development acceptance, not permission to collect real driver documents or process live payments. The visual redesign is deferred until the owner has tried the completed functionality.

## Before building a device-installable beta

1. Provision an isolated persistent staging API, PostgreSQL 17 (runtime and direct connections), private versioned encrypted storage, restricted TLS scanner, email/SMS sandbox providers, monitoring, authenticated schedules, backup and a trusted HTTPS ingress. Verify the *actual* identities and access boundaries, including the staged domain, health/readiness checks and restoration. Follow [deployment](DEPLOYMENT.md). No test fixture credentials or copied production resources.
2. Verify that the staging jurisdiction is explicitly approved **for staging only**. Admit synthetic users and synthetic vehicle/document content until provider, privacy and operational acceptance is complete. Leave `LIVE_FINANCE_ENABLED=false`, payout authority and live charges disabled. No production data or real card transactions.
3. Build separately for each mode. Set `APP_ENV=staging`, `NATIVE_ACCEPTANCE=0`, `EXPO_PUBLIC_APP_MODE=customer` or `host`, `EXPO_PUBLIC_API_ORIGIN` to the verified HTTPS staging origin, `ALLOW_DEV_PAYMENT_SIMULATION=false`, `LIVE_FINANCE_ENABLED=false` and a non-fixture `MOBILE_SMS_PROVIDER`. Run `node scripts/native-staging-probe.mjs` to perform read-only TLS/API readiness checks, then use `npm --prefix apps/customer run device-trial:android-prebuild` or `device-trial:ios-prebuild`, which invokes the configuration guard before native prebuild. The probe does **not** validate provider or infrastructure isolation and does not produce an installable signed binary.
4. Produce an arm64 Android build signed with a *private trial* signing key. CI's x86_64 acceptance APK is not a phone build. Protect the signing key and verify package ID, signature, embedded origin and TLS on a physical Android phone before sharing an install link.
5. Build an iOS **device** binary using an authorized Apple developer team, registered bundle identifiers and provisioning. Deliver to approved testers through TestFlight or an authorized device distribution mechanism. Simulator `.app` artifacts do not work on iPhone. Verify signing entitlements, bundle identity, embedded origin and TLS on an actual iPhone.
6. Exercise customer and host journeys on both devices with only synthetic data: sign-in, discovery, calendar, holds, identity/upload quarantine, booking evidence, messaging, case recovery, pickup, return, employee removal, session revocation and logout. Confirm all payment and payout calls are disabled. Capture sanitized screen/video evidence, logs and issues for the owner to review.

## Current gates

| Gate | State |
| --- | --- |
| Development merge of Phase 7D | Complete at `60cfc4ed0a308a193b345fb17474725aa72c8f83` |
| Persistent isolated HTTPS staging environment | Not verified |
| Real staging providers, scanner, monitoring and restore | Not verified |
| Android arm64 device signing and physical install | Not done |
| Apple device signing, TestFlight access and physical install | Not done |
| Manual screen-reader, large-text, camera and offline recovery | Not done |
| Live payment/payout enablement | Disabled; no approval |

Do not label a build as ready for the owner's phone until the relevant device and staging gates have evidence. The Android status-bar clipping and intermittent iOS navigation/recovery failures remain physical-device reliability checks. Native payment/deposit completion and some protected document workflows remain web-only or unavailable; document that behavior during the trial.
