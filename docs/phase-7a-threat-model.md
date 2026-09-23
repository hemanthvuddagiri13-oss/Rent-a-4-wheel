# Phase 7A threat model

Scope: the versioned customer/host API, email-code/device credentials, generated client, transaction composition and native private-file boundary. This is not a security certification or production approval. See `phase-7a-mobile-api.md` for the endpoint inventory, authorization matrix, lifecycle and launch requirements.

## Assets and trust boundaries

Assets include identity evidence, tenant data, authentication credentials, immutable reservation/financial evidence, private storage locators and audit history. The native app and all supplied identifiers, timestamps, amounts, role claims, headers and idempotency keys are untrusted. The API authenticates through PostgreSQL, invokes existing domain authority, and accesses private storage/provider boundaries only after authorization. TLS ingress is a separate deployment trust boundary. Browser cookies and native credentials are deliberately separate.

| Threat | Implemented control | Evidence and limit |
| --- | --- | --- |
| Enumeration and brute force | Uniform code issuance, shared hashed single-use/expiry/attempt rules, account/IP/cooldown guards, throttled-outcome audit | Real issuance/reuse/exhaustion/expiry/account and IP limit HTTP cases; external email delivery is a test double |
| Stolen/replayed refresh | Random opaque credentials, hash-only persistence, User-row serialized generations, consumed-token replay commits family revocation | Separate connections with barrier, one rotation winner then replay-revoked winner; lost response intentionally requires sign-in |
| Device theft | Five-minute access, seven-day refresh inactivity, 30-day family, per-device/all-device logout, active-device cap | Real HTTP logout, multi-device and disabled-account cases; rooted/jailbroken OS remains outside server control |
| Stale role or employee grant | Current active User and current host membership, no role claims in token | Role/membership changes tested without renewal; already-authorized in-flight work is not retroactively undone |
| Cross-tenant object references | Shared participant/host/owner guards, explicit DTO selection | Other customer and host cases cover reservations, documents, trips, agreements and conversations |
| Quarantined or expired evidence | CLEAN required, owner/current reservation tenant checked before storage, retention/deletion checks | Denied paths do not call storage; scan-unavailable/infected uploads make zero document/storage writes |
| Capability leakage | 60-second signature bound to user/device/document/purpose plus current bearer authentication | Expiry, signed wrong purpose/device, ID/user mismatch, signature tampering and employee revocation tested; no public URL |
| Malicious uploads | Immutable initialization, bounded raw bytes, hash/media/size validation, server re-encoding, CLEAN scan, durable stable storage identity | Synthetic image re-encoded by real sanitizer; scan/storage external doubles; existing storage suite covers uncertain provider writes |
| Duplicate/lost-response mutation | User+operation+fingerprint receipt and domain write in one transaction; authorize replay | Concurrent message barrier commits one message/revision/receipt; explicit transaction failure leaves no effect or receipt |
| Overlap/expired checkout | Shared vehicle/reservation locks, admission, original state machines and frozen legal evidence | Separate-connection hold contention, HTTP overlap/expired/jurisdiction cases and checkout acceptance replay |
| Authentication/domain deadlock | Session last-use CAS occurs before domain transaction; nested credential check is read-only | Two connections and User-lock barrier exercise refresh versus in-flight domain lock |
| Financial bypass | Shared checkout/cancel/start/report/trip services, authoritative payment projection, no mobile financial mutations | Existing financial groups remain mandatory; native checkout test creates zero provider payments and one immutable acceptance |
| Sensitive telemetry | Fixed operation/error codes, request ID/status/duration only; no URL/header/payload logging | Redaction sentinels and strict DTO contract tests; database security audit remains private |
| Abuse/exhaustion | Bounded streaming, pagination, global and mobile shared request limits, marketplace limits, device-family cap | Oversize/version cases through real Next.js proxy, issuance throttling and contract tests; infrastructure DDoS protection still required |
| Contract drift | One strict schema registry, deterministic OpenAPI/client generation, runtime DTO validation | Four contract tests, independent SwaggerParser validation, CI regeneration check |
| Upgrade destroys authority | Additive native tables and enum purpose only | Populated upgrade preserves web sessions/codes, payments, frozen quote, REVIEW reservation and ALLOCATION_REQUIRED issue exactly |

## Data minimization and operational assumptions

General DTOs never contain credential hashes, provider customer/account IDs, payment client secrets, storage keys, private URLs, license numbers, identity bytes, internal case notes, employee grants, raw audit records or policy approval internals. The only credential responses are successful sign-in/refresh. Identity bytes are returned only by the authenticated purpose-bound binary endpoint. No test or artifact contains real customer identity material or deployment credentials.

Trusted ingress must terminate TLS, validate body limits, strip/replace `x-real-ip` and prevent direct origin access. Request rate limiting cannot trust client-supplied forwarding headers. HMAC audit IPs minimize retained network identifiers but are not a substitute for ingress enforcement. Existing auth-code audits contain account email in private database audit records, never native request telemetry; approved retention/access controls still apply.

A code is consumed before device issuance. A crash between those steps requires a new code rather than permitting reuse. A refresh response lost after commit requires sign-in. Upload IO has a durable initialization and stable storage identity; ambiguous private writes remain held by existing storage recovery. Finalization never declares an uncertain object clean or creates a replacement key to escape review.

There is no mobile provider-payment/deposit endpoint, administrative financial mutation, approval override or legacy allocation resolution. Unsupported handoffs remain authenticated web-only. No native UI, real-device secure-store integration, device attestation or mobile penetration-test certification is claimed. Consumed hashes, mutation receipts and upload evidence currently retain conservatively; a professionally approved cleanup policy is required before native production launch, preserving replay detection and financial/legal holds.

## Separate financial requirement

The existing `ALLOCATION_REQUIRED` state remains blocked and cannot be resolved through `resolveFinanceIssue`. An **Authorized legacy REFUND_SUSPENSE allocation workflow** requires explicit professional accounting policy, SUPER_ADMIN/finance authorization, frozen allocation evidence, immutable adjustment journals rather than rewrites, conflict/amount validation, complete audit history and dedicated design, security and financial review. This batch adds no such workflow and releases no hold.
