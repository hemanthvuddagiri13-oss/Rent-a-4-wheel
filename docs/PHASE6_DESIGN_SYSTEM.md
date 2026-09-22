# Rent A 4Wheel design system

Brand: **Drive More Possibilities**. The interface represents a marketplace of independent vehicle providers. Approval, availability, financial state and identity status come from the server. Presentation never grants a capability.

## Foundations

Black backgrounds use `background`, `surface`, `card` and `card-elevated`. White is the primary text color; silver supports descriptions; muted text uses #a4a7ae. Restrained metallic gold #d6b66a identifies primary actions and focus. Secondary actions use neutral borders. Semantic positive, caution, negative and information tokens are paired with explicit text; color alone never carries status.

Use the self-contained system sans-serif stack for body text and the configured narrow sans-serif stack for display text; no third-party font request is required. Form controls use 16px text to remain legible on phones. Body copy uses 1.6 line-height. Prefer sentence case and meaningful headings. Do not use tiny uppercase text for essential pricing or instructions.

The spacing scale follows 4px increments: 4, 8, 12, 16, 24, 32, 48 and 64. Page gutters start at 16px, grow to 24px at 640px and 32px at 1024px. Reading/form content should be constrained; workspaces may grow to 1280px. Cards use 12–16px radii, controls 6–8px. Use a restrained shadow for elevation, not a gold glow.

Responsive thresholds follow the existing Tailwind stack: 640, 768, 1024 and 1280px. Acceptance additionally measures the six requested device sizes. Do not fix overflow by hiding the document overflow. Allow labels to wrap and give grid/flex content a zero minimum width. Dense tables need a named, keyboard-accessible scroll region or a mobile card equivalent.

## Controls and interaction

`Button` provides primary, secondary, outline, ghost, destructive and link actions. All button sizes have a 44px minimum target; long labels wrap. This is the product design target, not a claim that WCAG AA universally requires 44px. `LoadingButton` disables duplicate submissions while the caller's actual request is pending. The caller must announce an authoritative response or failure; loading is never confirmation.

`Input`, `Textarea` and `Select` share a visible border, 16px text, 44px minimum height, disabled presentation and focus treatment. Every instance still needs an associated label and descriptions/errors. Placeholder text is supplementary. Invalid fields use text and `aria-invalid`, not color alone.

Radix dialogs retain focus trapping, Escape and focus restoration. Close targets are 44px with visible focus. Dialog width includes mobile gutters and height is constrained to the dynamic viewport. Drawers scroll internally and account for the bottom safe area. Test them with a keyboard and at 200% zoom; library usage alone is not proof of accessibility.

Focus uses a 2px gold outline with a 3px offset. Scroll margins protect focused targets beneath the sticky header. Forced-colors mode uses system outlines/borders. Reduced-motion preferences suppress transitions and animation, including the loading spinner.

Booking progress is a seven-column responsive list with a current-step announcement and `aria-current="step"`. Mobile shows the current label above compact indicators; wide layouts show every label. Completion marks describe navigation progress only, never payment, identity or agreement approval.

## Content and authority

Use explicit labels such as Processing, Action required, Under review, Refund pending, Deposit release pending and Payouts disabled. Keep provider payloads, secrets and internal notes out of customer copy. Explain how to recover without promising that a retry succeeded. Do not invent insurance, legal, pricing or payout promises.

Financial summaries must retain server-frozen line items. Deposits, taxes, protection pass-through and host earnings remain distinct from platform fees. Private media use authorized private access; camera previews must stay local and must not enter screenshot artifacts.

## Implementation and acceptance status

Shared controls and initial responsive corrections are in progress. The approved baseline is recorded separately in `PHASE6_UX_BASELINE.md`. Full component adoption, all requested journeys, automated accessibility, manual keyboard verification, final screenshots and measured Lighthouse results remain required. This document does not certify completion or production readiness.

## Explicit acceptance exception

On 22 September 2026 the user approved retaining private-page `noindex` and documenting authenticated Lighthouse SEO as an exception to the 90+ score target. Raw scores remain in the report. The test still requires the indexing block and rejects any other weighted SEO failure on those pages. Public SEO remains 90+, Performance 90+, Accessibility 95+ and Best Practices 95+. No privacy or authentication rule is removed to improve a score.
