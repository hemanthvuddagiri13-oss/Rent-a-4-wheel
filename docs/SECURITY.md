# Security boundaries

This is a staging preparation, not a security certification or production authorization. All jurisdiction pricing is sample/unapproved. Live finance remains disabled. Hosts are independent vehicle providers responsible for physical vehicle custody, maintenance and handoffs.

## Identity and authorization

Auth.js encrypted cookies identify a database device session and credential rotation. Every application authentication check refreshes the active user and role and validates revocation, absolute expiry and idle expiry. The proxy is an additional origin, rate and response boundary; its cookie role is not authorization for a business operation. Device revocation, account suspension and former-employee removal take effect on the next authoritative check. Purpose-bound, one-use security codes protect release control and session rotation. Support must never reset credentials or bypass verification based only on a claimed email address.

Customer routes must bind ownership to the current user. Host routes require current host membership and vehicle/reservation association. Employee routes require their explicit business capability; being an employee does not grant unrestricted finance, identity or claim access. SUPER_ADMIN configuration changes require fresh reauthentication, a reason and audit. Existing emergency trip overrides do not bypass financial or jurisdiction gates.

## Request and deployment controls

Deployed configuration fails closed outside explicitly local development. Mutations require the configured origin, except machine routes with their own signature or bearer checks. Shared PostgreSQL rate budgets require a trusted ingress that replaces forwarding headers. Enforce ingress request and time limits as well as application limits. Private pages/API responses use no-store; CSP uses per-response nonces; deployed responses use HSTS. Validate redirects and headers at the actual ingress.

No production secrets, personal data or provider payloads belong in repository files, browser bundles, URLs, screenshots or logs. Telemetry accepts fixed event codes and bounded identifiers; exception contents are not logged. CI scans known credential formats and checks injected server-secret values against client artifacts. These checks are not a comprehensive credential-discovery guarantee.

## Private evidence

S3 keys are opaque. Each object has an immutable hash, size and lifecycle manifest. Persisted write intent precedes the provider call. An uncertain write requires review; retries cannot silently create another upload. Session advisory locks serialize upload/deletion. Application reads require current business authorization, CLEAN state and verified bytes. No direct S3 URL is returned to users. KMS encryption, private bucket configuration, TLS and exact-version deletion are verified by the adapter.

Scans remain unreadable on errors, incomplete replies or unavailable scanners. Bounded jobs enter REVIEW instead of disappearing. Review does not authorize an infected download. Retention and evidence holds precede deletion intent; deletion is terminal and preserves audit evidence. Existing financial/claim/legal holds must not be cleared as a storage repair. Unknown legacy objects require controlled inventory/import before deployed reads; do not backfill a CLEAN status without scanning.

## Jurisdiction and pricing

Admission decisions use server-side versioned jurisdiction gates. Every state starts DISABLED; STAGING is the only available enabled mode. Disabling admissions does not disable returns, claims, refunds or financial recovery. Release flags cannot replace jurisdiction, accounting or legal requirements. Snapshot immutability prevents policy edits from changing prior financial terms. Tax, deposit, host, protection and unsettled balances are liabilities, not platform revenue.

## Evidence and remaining work

Database race tests use separate connections and explicit barriers where concurrency is claimed. Protocol fixtures exercise real SDK/scanner clients but do not establish real-provider readiness. Deployed TLS/IAM, scanner signatures, provider accounts, backup restoration, penetration testing, load and incident exercises require separate recorded evidence. See RELEASE_CHECKLIST.md and OPERATIONS_RUNBOOK.md. Report suspected access or financial incidents through the restricted operator process, without attaching raw private documents to public issues.
