# Phase 7B customer application

Base: approved main `e5e2564a5a5f753e8db2cc2408efd843e0cb1fbf`. Branch: `codex/phase-7b-customer-app`. This is a draft implementation for independent review, not production approval. No schema or migration changes. Live payments and payouts remain disabled.

## Architecture

`apps/customer` is an independently locked Expo SDK 57 / React Native 0.86 / React 19.2 application. It does not force the web app to share React or native build dependencies. Expo Continuous Native Generation produces Android/iOS projects from versioned configuration; generated projects are ignored. React Navigation owns the typed native stack and platform back behavior. Feature screens are separated from shared accessible controls, session coordination, secure storage and upload handling. TanStack Query provides in-memory server reads, cancellation and foreground refresh. No query data, driver details, message bodies or image bytes are persisted by the app.

The app imports `packages/mobile-client/src` directly through Metro's explicit watch folder. Regenerating the API client updates both apps. The server owns jurisdiction admission, dated availability, holds, pricing, agreement hashes, document quarantine, checkout, financial status, trip eligibility, case access and review eligibility. The customer UI uses `paymentStatus.outcome === confirmed`; checkout preparation never means confirmation. No native payment or payout authority is introduced.

Design tokens reuse the existing black/silver/gold palette. Native controls support dynamic text, labeled inputs, accessibility roles/state, at least 52-point primary targets, scrollable layouts, error announcements and permission explanations. No Turo assets or legal text are used. No supplied real photo is copied without approval: the API only returns CLEAN files explicitly designated LISTING_PHOTO for the current vehicle host after public listing/jurisdiction/release checks. Unverified VehicleImage URLs are excluded. Demo inventory remains excluded from bookable discovery.

References: [Expo SDK compatibility](https://docs.expo.dev/versions/latest/), [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/), [local native builds](https://docs.expo.dev/guides/local-app-overview/), [Maestro CLI](https://docs.maestro.dev/maestro-cli). SDK 57 requires Xcode 26.4+, iOS 16.4+ and Android 7+. The lockfile pins dependencies. A transitive build-time UUID override selects the patched CommonJS-compatible 11.1.1; build verification must cover the override.

## Credentials, retries and privacy

One process-wide coordinator serializes refreshes. Credentials are stored together in SecureStore with WHEN_UNLOCKED_THIS_DEVICE_ONLY. Before sending a one-use refresh token, the app persists a refreshing marker. A lost response, provider rejection, storage failure or restart with that marker requires fresh email-code authentication. It never retries an uncertain refresh. Concurrent late 401s share the new generation. Logout revokes on the server before erasing storage; offline logout honestly reports failure and retains credentials for a revocation retry.

Domain mutations are not automatically retried on network failure. User-triggered retries reuse a secure, account-scoped random idempotency key bound to a hash of the exact request. No mutation payload is persisted. Completed intentions release their key; upload initialization retains its identity through a later failed finalize. Upload bytes stay in memory and app-owned picker cache; cache copies are deleted on completion or screen disposal. A killed app requires photo reselection; server document status is available on the checkout screen. Expired or uncertain upload intents remain blocked rather than allocating replacement storage automatically. Restarting such an expired intent needs future explicit recovery UX and server reconciliation policy.

Identity and inspection screens prevent capture where the platform supports it. Background app content is covered. These are privacy precautions, not device-compromise protection or a guarantee against external cameras. Condition previews use authenticated bytes held in memory, never public URLs. Identity preview, agreement PDF export and case attachments remain outside this batch.

## Minimal API additions proposed for review

| Operation | Boundary |
| --- | --- |
| POST `/vehicles/{id}/availability` | Bounded future UTC interval; same visibility/release gates and shared `isVehicleAvailable`; explicitly requires a later hold |
| GET `/vehicles/{id}/photos` | Current visible vehicle; only CLEAN designated listing photos matching its host; returns existing gated public-listing paths |
| GET `/reservations/{id}/reports/{reportId}/photos/{photoId}` | Native bearer, current reservation participation, exact report/photo association, CLEAN/STORED/nondeleted private object, audit before private read, no-store binary |
| GET `/cases/{id}/events` | Current case access on every page; internal notes excluded; strict DTO and bounded pagination |

OpenAPI and typed client are regenerated from the same runtime schemas. All four additions have real PostgreSQL/HTTP regression coverage. Prior mobile/security tests remain intact.

## Journeys and deliberate unavailable states

Email-code login, secure restore/refresh, catalog/detail/photos, native date/time selection, dated availability, hold acquisition, reservation pricing, document selection/upload, frozen agreement review and checkout preparation are implemented. Reservations poll authoritative payment status. Trip screens show current blockers, inspection capture, saved private report previews, author acceptance, server-gated trip start and customer return initiation. Messaging, notices, support ticket creation/history/replies, vehicle reviews and device/session logout use the generated client.

Payment/deposit completion is explicitly unavailable. No approved native-to-web session exchange exists, so the app does not forward bearer tokens through URLs or create a misleading web checkout button. Users cannot complete a new paid booking end to end in this batch. Date selection checks a selected vehicle; nationwide date-filtered catalog search remains a future contract. Identity/agreements/business files and case attachments retain their existing protected web workflows. Notification preferences/read markers, incident-specific intake, host reviews and review editing are future UX additions. Physical handoff and key release remain host responsibilities.

## Verification and running locally

From `apps/customer`: `npm ci`, `npm run typecheck`, `npm start`, `npm run android` or `npm run ios`. Set `EXPO_PUBLIC_API_ORIGIN` to the explicitly approved HTTPS API origin before building. Default configuration uses the staging hostname; it is not evidence that a staging deployment exists. Production signing, bundle ownership, privacy disclosures, store submission and deployment approval remain required.

The native CI workflow builds actual release-mode Android APK and iOS simulator `.app` binaries, installs them, and runs Maestro against the real production-build Next.js server/PostgreSQL with synthetic accounts. Acceptance builds use a different bundle ID ending `.acceptance` and permit only `http://localhost:3000`; regular builds require HTTPS and deny Android cleartext. Only synthetic screenshots/results and app binaries are uploaded; raw backend logs, credentials and real identity evidence are excluded. These synthetic-backend acceptance builds are not signed store releases.

The synthetic email-delivery fixture seeds a hashed, single-use code and exercises actual issuance throttling, bcrypt consumption, bearer authentication and logout; it does not prove delivery through a real email provider. Unit tests cover serialized refresh, concurrent 401s, lost refresh, crash marker, revocation, storage failure, offline mutation recovery and logout failure. The existing real PostgreSQL mobile suite covers code reuse, upload failures/retries, revoked access, booking races and trip gates, alongside the four new contracts. Camera hardware, external email/scanner/storage, VoiceOver/TalkBack and production-network behavior require device/staging acceptance; do not infer them from automated unit tests.

Exact CI results, actual captured screenshots and native build limitations must be recorded in the delivery report. On the local Windows host no simulator/Android SDK is available and Hermes compilation was blocked by process-spawn permissions; local native builds are not claimed.
