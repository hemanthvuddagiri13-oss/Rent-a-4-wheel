# Phase 7D: mobile recovery and device assurance

Base: development main `ef01c17a6f771a08bad0075304c6c6a6288e5b1b`. Work in progress, not production approval.

## Required verification

- Reproduce and diagnose customer iOS navigation failure using native input evidence, without treating an unchanged rerun as a diagnosis.
- Recover uncertain messages, uploads and trip actions across request loss and process restart using the original immutable request and idempotency key; retain current server authorization and all domain gates.
- Exercise secure credential storage, rotation/revocation, protected-screen capture behavior, accessibility and safe-area layout.
- Run exact-commit API, financial, web and both native platforms; publish only sanitized synthetic screenshot evidence.

No physical Android/iOS tooling is available on the current Windows host. CI emulator/simulator evidence must be labeled separately; physical-device, assistive-technology, real-provider and distribution-build acceptance remain unverified until actually performed.

Live payments and payouts remain disabled. Lost-phone recovery remains review intake only. No approved migrations or financial authority may be changed by this phase.
