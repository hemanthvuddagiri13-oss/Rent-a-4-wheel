# Phase 7A threat model

Status: implementation in progress, not a security certification.

| Threat | Required control | Evidence required |
| --- | --- | --- |
| Email enumeration and brute force | Uniform issuance response; shared per-account/IP cooldown and attempt limits; no code in responses or logs | Real code issuance, reuse and exhaustion tests |
| Stolen/replayed refresh credential | Random opaque credential, hash only at rest; family generation; atomic rotation; consumed-hash reuse revokes family | Separate PostgreSQL connections and synchronization barrier |
| Device theft | Short access lifetime, immediate per-device/all-device revocation, bounded absolute family lifetime | HTTP logout and disabled-account tests |
| Stale roles or employee access | Current active user and current host membership for every sensitive operation | Change/revoke membership between requests |
| Cross-tenant IDs | Existing customer/host domain guards before data or storage access | Other customer/host fixtures |
| Quarantined documents | Authorize before storage; clean scan required; server media validation/re-encoding | Storage spy remains untouched on denial |
| Leaked signed file access | Short-lived purpose-bound capability plus current bearer authorization on redemption; no public object URLs | Expiry, purpose mismatch and employee revocation tests |
| Duplicate mutations or lost responses | Durable immutable fingerprint and atomic domain deduplication; never replay a stale authority decision | Concurrent retries and crash/replay tests |
| Financial authority bypass | Shared domain entry points and locks; no client-supplied pricing or mobile admin mutation | Existing financial groups and mobile hold/jurisdiction tests |
| Logging and error disclosure | Fixed error codes, allowlisted metrics, no request payload/header logging | Redaction assertions with sentinel secrets |
| Resource abuse | Bounded streamed bodies, pagination, shared DB rate limits and trusted proxy IP policy | Oversized body, bad pagination and rate limit tests |
| Contract divergence | Versioned OpenAPI and deterministic generated client | CI validation and clean regeneration |

Never return credential hashes, provider customer/account identifiers, payment secrets in general DTOs, storage keys, private URLs, license numbers, identity images, internal case notes, employee access grants, raw audit records or financial policy approval internals. An explicitly authenticated payment SDK handoff, if implemented, must be separately scoped and never cached/logged.

Deployment must terminate TLS and strip/replace trusted client-IP headers at the ingress. Client-provided forwarding headers cannot establish a trusted IP. Native tokens are bearer credentials: secure device storage, platform compromise handling and certificate-validating HTTPS remain client responsibilities.

## Deferred financial requirement

The existing `ALLOCATION_REQUIRED` state remains blocked; mobile adds no resolution path. A future **Authorized legacy REFUND_SUSPENSE allocation workflow** requires professional accounting policy, SUPER_ADMIN/finance authorization, frozen allocation evidence, immutable adjustment journals, conflict/amount validation, complete audit history and dedicated design, security and financial review.
