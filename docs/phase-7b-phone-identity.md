# Phone-first customer identity — draft security design

The native app starts with phone OTP registration/sign-in. Email fallback is a separate visible screen and only issues login codes for an already verified, linked email. Existing verified web identities are preserved. Unverified legacy contact numbers are not migrated into login identities.

## Authority and storage

`MobilePhoneIdentity` assigns one normalized E.164 number to one User with a unique constraint; User.phone is only contact data. libphonenumber-js validates and normalizes US national input and explicit international numbers. Native phone registration never accepts an email or role, never searches legacy contact fields, and creates CUSTOMER only. A random `@phone.identity.invalid` internal address preserves the established non-null web User schema. It is not a verified email, cannot receive mail, cannot enable fallback, and is replaced only after authenticated email proof. There is no heuristic account merge.

New migration `20261001010000_mobile_phone_identity` is additive. It does not rewrite migrations, backfill phone authority, touch financial evidence, or release existing holds. The populated upgrade test preserves existing phone/contact data without granting phone login.

Provider intent is committed before delivery. Requests are serialized by target/IP/device advisory guards, with a 60-second resend cooldown and hourly caps of 5 per target, 20 per trusted-ingress IP hash and 10 per device. Verification atomically reserves at most five attempts and an exclusive claim before contacting the provider. The provider approval is bound to the exact service and verification SID, with one durable receipt per SID. Local verification consumption and account/session effects commit together. Successful verification on two separate challenges for the same number still creates only one identity/account.

Delivery/check timeouts and uncertain results fail closed. The app never retries provider calls automatically, never infers approval from a Twilio 404, and never substitutes a local code for a missing provider. A crash after a provider check but before local commit leaves CHECKING/FAILED and requires a fresh challenge; the OTP may already be consumed. This deliberately sacrifices retry convenience rather than infer ownership. Approval cannot create duplicate local authority on replay. Expired challenges cannot authenticate.

Audit events contain fixed action names, opaque challenge IDs and an authenticated actor where available; no phone, email, OTP, token, provider payload or request body is logged by the new identity service. Targets are private database PII, not public DTO fields. Login-method DTOs expose only the caller's masked phone and verified email. Production retention and deletion schedules for identity evidence require privacy/security approval before launch.

## Linking and changing methods

Authenticated linking requires a current native credential and a session created within ten minutes. The service rechecks session activity after acquiring the user lock and after external verification. Linking a number/address already owned by another account is rejected without merging or moving it. A previously verified email cannot be replaced through the linking route. New email proof is bound to the exact current session and challenge, separately from sign-in codes.

A normal phone change requires proof of the current number, bound to its identity version and current session, followed within five minutes by a separate replacement-number proof. The old proof is consumed when the replacement intent is recorded. Applying the replacement rechecks the old number/version, keeps uniqueness, audits the change and revokes all native sessions. Other successful method links revoke other native sessions. Web cookie sessions are not granted or promoted by this API.

Phone-only users can browse and sign in, but shared hold and checkout logic require a verified account email before booking. Native checkout for a phone identity must use that verified email for driver correspondence. Linking is monotonic; these endpoints do not remove a verified email. Payment, deposit, jurisdiction, tenant, document, agreement and trip rules remain server-authoritative.

## Lost phone and risky changes

Use the already linked email to establish a fresh session. Verify the replacement number, then submit a recovery review request. This creates a durable REVIEW_REQUIRED record and a private support case containing an opaque reference. It does not change the existing phone, issue new financial authority, release holds or revoke legitimate sessions. Replays cannot duplicate that record/case. Support case closure is not identity authorization. Without access to either verified method, the app directs the person to official support and grants no session.

Account transfer following lost-phone identity review remains blocked until a separately authorized recovery decision workflow is designed and independently reviewed. No support role can change identity through this intake, and direct database edits are not a supported recovery process. Such a workflow needs documented evidence criteria, independent privileged reviewer authorization, conflict/ownership checks, session revocation, notifications to existing verified methods, immutable evidence and complete audit history. A claimed replacement phone alone is insufficient.

## Provider configuration and acceptance

Defaults: `MOBILE_SMS_PROVIDER=disabled`, `MOBILE_SMS_SEND_ENABLED=false`. Missing credentials do not silently enable fixtures. Development/test may explicitly use `MOBILE_SMS_PROVIDER=fixture` with `MOBILE_SMS_FIXTURE_CODE`; this accepts only fictional +1 202-555-0100 through 0199 and never performs network I/O. Fixture mode is rejected in staging/production. Twilio mode is rejected in development/test/preview even if valid credentials and the send flag exist.

Real sends require staging/production, `MOBILE_SMS_PROVIDER=twilio`, `MOBILE_SMS_SEND_ENABLED=true`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_VERIFY_SERVICE_SID`. Store these only as server environment secrets. No real SMS was sent during this implementation. A separate approved staging exercise must validate real carrier delivery, provider status/error shapes, geo-permissions, Fraud Guard, service-side rate limits, billing limits, code expiry and abandoned/reused numbers. Review recycled-number/SIM-swap risks and recovery policy before launch. Fixture tests are not production readiness evidence.

References: [Twilio verification checks](https://www.twilio.com/docs/verify/api/verification-check), [verification lifecycle](https://www.twilio.com/docs/verify/api/verification), [service rate limits](https://www.twilio.com/docs/verify/api/service-rate-limits), [code lifetime and resend behavior](https://www.twilio.com/docs/verify/api/rate-limits-and-timeouts). The adapter uses direct HTTPS calls with bounded timeouts and no automatic retries.

Live payments and payouts remain disabled. This design and all new identity endpoints require independent security review before production use.
