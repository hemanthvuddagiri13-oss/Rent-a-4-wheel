# Private device trial: readiness and limits

Current native CI artifacts are **not installable private-beta builds**. Android acceptance builds target the x86_64 emulator and embed `http://localhost:3000` and synthetic provider settings. iOS acceptance artifacts use the simulator SDK with ad-hoc simulator entitlements; they cannot be installed on a personal iPhone or distributed through TestFlight. The workflows use disposable PostgreSQL and fixture accounts, SMS, scanner and storage boundaries. No persistent staging deployment or signed device distribution is established by those jobs.

The approved Phase 7D merge is development acceptance, not permission to collect real driver documents or process live payments. The visual redesign is deferred until the owner has tried the completed functionality.

## Before building a device-installable beta

1. Provision an isolated persistent staging API, PostgreSQL 17 (runtime and direct connections), private versioned encrypted storage, restricted TLS scanner, email/SMS sandbox providers, monitoring, authenticated schedules, backup and a trusted HTTPS ingress. Verify the *actual* identities and access boundaries, including the staged domain, health/readiness checks and restoration. Follow [deployment](DEPLOYMENT.md). No test fixture credentials or copied production resources.
2. Verify that the staging jurisdiction is explicitly approved **for staging only**. Admit synthetic users and synthetic vehicle/document content until provider, privacy and operational acceptance is complete. Leave `LIVE_FINANCE_ENABLED=false`, payout authority and live charges disabled. No production data or real card transactions.
3. Build separately for each mode. Set `APP_ENV=staging`, `NATIVE_ACCEPTANCE=0`, `EXPO_PUBLIC_APP_MODE=customer` or `host`, `EXPO_PUBLIC_API_ORIGIN` and `DEVICE_TRIAL_STAGING_ORIGIN` to the same verified bare HTTPS `staging.` origin, `ALLOW_DEV_PAYMENT_SIMULATION=false`, `LIVE_FINANCE_ENABLED=false` and `MOBILE_SMS_PROVIDER=twilio`. These client build declarations do not configure or certify the server's SMS provider. Run `node scripts/native-staging-probe.mjs` to perform read-only TLS/API readiness checks, then use `npm --prefix apps/customer run device-trial:android-prebuild` or `device-trial:ios-prebuild`. Expo configuration itself enforces the guard even if the npm wrapper is bypassed. The probe does **not** validate provider or infrastructure isolation and does not produce an installable signed binary.
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

## Build outputs and credentials

The `Device trial compile (unsigned)` workflow compiles both customer and host for Android **arm64-v8a** and Apple's **iphoneos** device SDK. It verifies actual package identifiers, embedded API origin/acceptance flag and native architecture. Android release signing is explicitly removed from Expo's default debug-key template. A template change fails the build rather than silently signing with the public debug key. iOS is compiled with signing disabled. Artifacts/receipts explicitly say `phoneInstallable:false` and `stagingVerified:false`.

The compile-only origin `https://staging.compile.renta4wheel.com` is not a deployed service. **Do not sign or distribute these compile-test APKs.** Rebuild against the independently verified real staging origin before signing. An unsigned APK or device archive is not an installable trial. The workflow does not upload an iOS archive or any signed binary. This repository is public; it is not an approved private app distribution channel.

Trial package IDs are `com.renta4wheel.customer.trial` and `com.renta4wheel.host.trial`, separate from acceptance and future production apps/credential storage. No financial gate or user-facing workflow is bypassed.

### Android local signing after staging acceptance

No Google Play account is required for a direct, private APK installation. A private keystore under the owner's custody, Android SDK/JDK and a physical arm64 Android phone are required. Create/retain a dedicated trial key outside the repository; back it up securely so subsequent builds can update the app. Never use the emulator/debug key, commit a keystore, paste passwords into chat or place signed binaries in public CI artifacts. The repository ignores common signing formats as an additional precaution, not a secret-storage system.

After configuring the real staging origin and passing the probe, run the Android prebuild, then `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` from `apps/customer/android`. Verify the unsigned output using `scripts/verify-unsigned-device.py` with `ANDROID_BUILD_TOOLS` set to the selected SDK Build Tools directory. Keep the resulting manifest and SHA with the approved build.

Use the SDK's `zipalign` before signing, then `apksigner sign --ks /private/path/trial.jks --out /private/path/trial-signed.apk app-release-unsigned.apk`. Let the tool prompt for passwords; do not put them in shell history. Run `apksigner verify --verbose --print-certs /private/path/trial-signed.apk` and independently compare the signer certificate fingerprint with the owner's key. Install by a trusted local USB/ADB connection or an approved private distribution service. No such key, signing, distribution or physical install is performed by this PR.

### iPhone / TestFlight after staging acceptance

Use a Mac with the supported Xcode toolchain and an authorized Apple Developer team. Register **both** trial bundle IDs, configure signing/provisioning in each generated Xcode workspace, and archive for a generic iOS device with signing enabled. Do not attempt to install the simulator app or the unsigned CI device archive. For registered-device distribution, register the actual device UDIDs and use an appropriate profile. For TestFlight, create both App Store Connect app records, supply an authorized role, upload a signed distribution archive, complete required metadata/compliance and any required beta review, then invite the intended testers. Do not enable a public invitation link by default. Team membership/profiles, App Store Connect access, device registration and review cannot be manufactured by repository code.

References: [Expo local release builds](https://docs.expo.dev/guides/local-app-production/), [Android apksigner](https://developer.android.com/tools/apksigner), [Apple device/beta distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

For a single owner's tethered personal-device test, Apple also offers Xcode Personal Team signing with a free Apple Account, subject to capability, device and short-lived provisioning limits. That is a separate local option to evaluate on the owner's Mac/iPhone; it does not grant TestFlight distribution. A paid Developer Program membership is genuinely required for TestFlight, not for every possible personal USB test. See [Apple membership comparison](https://developer.apple.com/support/compare-memberships/). Neither option has been tested with an authorized account in this task.

## Isolated HTTPS backend recipe (not a deployed environment)

`Dockerfile.staging` builds a standalone Node24 server without credentials or `.env` files, runs it as a non-root user and rejects non-staging/live-finance/bypass startup. Its separate `migration` target invokes the existing direct-database migration guard; startup never migrates, seeds or approves policies. `deploy/staging.compose.yml` exposes only Caddy ingress, with the app on the private container network. The ingress requires an explicit tester/VPN CIDR allowlist, replaces untrusted IP headers and sets noindex. It is intended to be the direct TLS edge; placing another proxy/CDN in front requires a separate reviewed trust configuration. Do not use `0.0.0.0/0` or `::/0` for a private trial.

Before running it, provision DNS for an owned `staging.` hostname, a host/container account with restricted firewall access, managed PostgreSQL17 with direct TLS connectivity and backups, a separate private encrypted/versioned S3 bucket and KMS key, a restricted TLS ClamAV service, staging email/Twilio Verify and Stripe **test-only** accounts, monitoring and every authenticated worker schedule in `deploy/r4w.cron`. Verify actual resource IDs/IAM and restoration; names and environment labels are not proof of isolation. The existing readiness validator intentionally refuses missing dependencies. Do not replace them with CI fixtures or weaken readiness to make the probe green.

Keep the runtime secret environment file outside the repository, permission-restricted and injected from the selected secret manager. Supply `TRIAL_ENV_FILE`, `TRIAL_HOST` and `TRIAL_ALLOWED_CIDRS` externally; use `docker compose -f deploy/staging.compose.yml config --quiet` to validate structure without printing resolved secrets. Build the image, run the explicit migration step only after backup/review, configure schedules, and start the restricted ingress. Pin/review the resolved Node/Caddy image digests for deployment. The CI image test proves liveness and fail-closed readiness **without credentials**, not real TLS/DNS/provider readiness. Run the real HTTPS probe from an allowed tester network after provisioning; separately test denied network access and spoofed forwarding headers.

The private trial must still use synthetic driver/document/vehicle data. Real phone/email verification needs authorized staging provider configuration and tester consent; this PR sends no SMS/email and performs no real provider operation. Missing staging jurisdiction/agreement/pricing approvals must remain visible blockers; do not silently approve sample policies or mutate financial authority to unlock a journey.

Next.js freezes public browser configuration during compilation. Set `TRIAL_PUBLIC_SITE_URL` to the verified staging origin and `TRIAL_STRIPE_TEST_PUBLISHABLE_KEY` to the public `pk_test_` key when building through Compose; set the matching runtime `SITE_URL`/`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in the protected environment. The image stores only those public build inputs and refuses conflicting runtime values. Never supply secret Stripe/provider keys as build arguments. The credential-free CI image uses a compile-only origin and no publishable key, so it must be rebuilt with the real public staging inputs before deployment. This does not enable live finance.
