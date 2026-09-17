# Phase 3: communications and case operations

## Entry points

Customer and host reservation pages link to the private conversation, reviews, support, and case intake. Vehicle pages offer pre-booking inquiries and eligible public reviews. /connect contains inbox, notifications, reviews, support, private host reputation, and cases. /connect?view=operations provides role-specific queues, deadline reporting and administrative controls.

SUPPORT_AGENT handles messaging, incidents and tickets. CLAIMS_AGENT handles claims, disputes and incidents. ADMIN handles messaging, tickets, review moderation and configuration. SUPER_ADMIN has exceptional operational access; a financial disposition still requires the approved financial workflow. Every service rechecks the current database role and current host membership. A customer who is also an operator remains a party on their own reservation. Assignment rejects parties and affiliated hosts.

## Evidence and decisions

Cases serialize with the existing reservation/vehicle lock and a case row lock, then compare version. The timeline records immutable decisions and the deadline in effect. Original accepted trip photos are referenced, never rewritten. New evidence has its own private key, hash, timestamp and scan gate. Upload accepts sanitized JPEG/PNG/WebP images up to 8 MB (including images of estimates, invoices and police reports); PDF and arbitrary files are not accepted.

New upload intent is persisted before storage. STORING or QUARANTINED copies cannot be served, including after a lost provider response. They remain tracked for retention; users can retry an upload. Reads authorize and log access before accessing storage. There are no public evidence URLs. Claims and disputes set sticky financial REVIEW and, when a successful rental payment exists, open the existing financial-review case. Closing a case does not clear REVIEW, charge a card, release a deposit, or bypass trip start. A party appeal reopens operational and financial review. Super-admin exceptional decisions require a separate one-use email code and reason.

Safety incidents block the vehicle and flag upcoming reservations. Closing an incident does not restore inventory. A later inspection or repair plus an operator clearance is required; the host then separately controls listing availability.

## Delivery and scheduling

Deploy the existing financial/outbox cron schedules plus GET or POST /api/cron/community with Authorization: Bearer CRON_SECRET. vercel.json includes the schedule; other hosts must install it explicitly. The community worker projects transactional events, plans generic email via the existing outbox, sends consented SMS, and runs retention. In-app notices are durable independently of provider success. Notice links reauthorize the target on every access. Email/SMS content contains no message body, identity image, or claim evidence.

Optional SMS configuration: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, and TWILIO_INBOUND_URL (the exact public /api/community/sms URL, including any configured query). Configure Twilio's signed inbound POST at that URL. The user requests a unique account enrollment code, then sends START plus that code from the handset within 24 hours. Signed STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT revokes consent. Phone entry alone cannot authorize a send.

Each channel job is unique per notice/channel. SMS intent and exclusive claim precede provider dispatch. Accepted means accepted by Twilio, not delivered to the handset. An uncertain response or expired dispatch becomes REVIEW and is not automatically resent; investigate provider records. Definitive rejection becomes DEAD_LETTER. Operators see safe error codes, never credentials or message content. Push records are CONFIGURATION_REQUIRED until a mobile provider is implemented; this is intentionally architecture for future mobile apps, not a claim of push delivery.

Provider references: https://www.twilio.com/docs/usage/security and https://www.twilio.com/docs/messaging/api/message-resource .

## Retention

Admin settings govern new-record deadlines separately for messages, images, reviews, claims, disputes, incidents, tickets and channel-delivery metadata. Existing deadlines are not silently shortened. Legal/security holds and financial/agreement evidence prevent ordinary deletion. Privacy requests produce a review queue and user-visible status, never unconditional erasure.

Private deletion takes the existing financial reservation lock before parent and file locks. Durable financial intents protect evidence even before a Payment projection exists. Deletion serializes with parent holds and file state. The worker commits irreversible logical deletion and an audit event before deleting the exact provider key. Reads then stop. A lost provider response retries the same key; not-found is success. Fenced completion prevents stale workers overwriting recovery. Failed jobs back off then dead-letter; super admins may request an audited exact-key retry. Holds added after committed logical deletion cannot revive an already deleted copy. Channel tombstones preserve deduplication after metadata retention.

## Verification and release gates

The workflow runs fresh migrations, seed, typecheck, lint, the full PostgreSQL/browser suite twice, three relevant concurrency groups five times each, and a production build. The new browser suite runs a real Next server, real PostgreSQL and Chromium, with synthetic authenticated users and a TCP ClamAV protocol fixture. SMS tests replace the provider boundary; they do not prove live Twilio enrollment or handset delivery. Original financial tests are retained.

Before production: approve role assignments, response/review/retention policy, roadside and insurance contact text, privacy/legal processes, and messaging consent wording. Configure and exercise live private storage, current ClamAV signatures, email, the deployed cron secret/scheduler and optional Twilio registration/consent/delivery. No insurance coverage is promised by this implementation. Existing Phase 1/2 payment and deployment release gates still apply. Test screenshots and exact final CI results are recorded in the PR/delivery report, not inferred from unit tests.
