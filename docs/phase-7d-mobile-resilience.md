# Phase 7D: mobile recovery and device assurance

Base: development main `ef01c17a6f771a08bad0075304c6c6a6288e5b1b`. Work in progress, not production approval.

## Required verification

- Reproduce and diagnose customer iOS navigation failure using native input evidence, without treating an unchanged rerun as a diagnosis.
- Recover uncertain messages, uploads and trip actions across request loss and process restart using the original immutable request and idempotency key; retain current server authorization and all domain gates.
- Exercise secure credential storage, rotation/revocation, protected-screen capture behavior, accessibility and safe-area layout.
- Run exact-commit API, financial, web and both native platforms; publish only sanitized synthetic screenshot evidence.

No physical Android/iOS tooling is available on the current Windows host. CI emulator/simulator evidence must be labeled separately; physical-device, assistive-technology, real-provider and distribution-build acceptance remain unverified until actually performed.

Live payments and payouts remain disabled. Lost-phone recovery remains review intake only. No approved migrations or financial authority may be changed by this phase.

## Implementation and evidence boundaries

The recovery coordinator persists immutable request inputs, original optimistic versions and idempotency keys before dispatch in account-scoped device Keychain/Keystore records. It serializes writes, freezes inputs before asynchronous work, refuses replacement of an uncertain action, and removes pending intent only after an acknowledged response. All replay uses the current session and the existing API authorization/receipt checks. Account → Interrupted requests provides explicit recovery; no background replay is performed. Locked credential storage now surfaces a startup failure without deleting a potentially valid session.

Private upload recovery saves only the original descriptor and image hash, never image bytes. After process restart the user must reselect exactly the same image in the original upload screen. A different hash cannot silently replace an uncertain upload. Losing access to that original image currently requires support; no administrative bypass or insecure persistent image copy is introduced.

Secure recovery snapshots use small encrypted storage chunks and an atomic generation pointer. Process death before pointer publication can leave unreachable encrypted chunks; orphan cleanup/retention and physical-device storage-capacity testing remain required production follow-ups. Pending requests are not transferable across accounts. Conflicting or permanently rejected requests remain visible for support review rather than being automatically discarded and resubmitted.

The prior iOS log at 4ff3c32 records a Sign in tap at (201,509), followed by the driver's generic hierarchy-change completion, but no verified navigation. The failure hierarchy remains Home. This establishes a missing destination assertion, not why the tap was missed. The new native flow repeatedly exercises Home → phone sign-in → email fallback → Back with stable IDs, centered targets and mandatory destination assertions. No retry/sleep converts a missed tap into success. A physical-device root-cause conclusion is not yet supported.

Installed recovery scenarios intentionally truncate committed HTTP responses and terminate/relaunch the app. Customer and host messages, host support reply, host return action and host upload must recover through the same real Next.js/PostgreSQL backend, followed by uniqueness assertions. These are planned checks until their exact-SHA runs finish. Unit recovery stores are fixtures; they do not prove native encryption. CI screen-capture and session checks do not establish resistance on rooted/jailbroken devices, VoiceOver/TalkBack usability or physical system-bar behavior.
