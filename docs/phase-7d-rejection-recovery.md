# Phase 7D correction: durable rejection and private recovery

Reviewed base: `26a91cc84793d41d3a06ca7f4e10a583e0de5ea7`, draft PR #10.

## Non-commit contract

HTTP status alone never releases a pending intent. Message send, case reply,
case creation and date holds can return `error.nonCommit.idempotencyKey` only
when their command transaction has rolled back and a second transaction has
persisted a terminal rejection under the same user/operation/key advisory lock.
Both transactions recheck current authorization. An earlier committed receipt
wins; no rejection may overwrite it. Failed receipt persistence remains uncertain.
Existing successful fingerprints/receipts retain their representation.

The client requires the API version, matching response request ID, exact key,
and the supported status/code pair. A bare 400/409, authorization failure,
malformed response, transport loss, generic fingerprint conflict or server error
preserves the original immutable identity. This is not blanket 4xx disposal.
A durable rejection allows corrected input and a new key after restart.
Operations without path parameters (including hold and openCase) retain their
conservative operation-wide conflict scope while uncertain. Changing vehicle,
dates, reservation or body does not evade that scope.

## Privacy audit and storage contract

Previously the journal serialized the full mutation input into encrypted,
device-local SecureStore chunks. Encryption did not make this minimal retention:

| Input | Previously retained | Now retained |
|---|---|---|
| Checkout | Driver name, DOB, email, phone, address/city/state/ZIP/country, license number/state/expiration; document IDs and agreement/booking evidence | No body or path parameters |
| Messages/replies | Full text, conversation/case ID, reply version | No text, identifiers or version |
| Cases | Title/body, people, location, police report/provider, incident details and photo IDs | No case content |
| Host handoff/report | Notes, comparison/check data, condition/photo descriptors | No notes, comparisons or descriptors |
| Upload recovery | Photo descriptor/hash and reservation scope (never image bytes) | No descriptor or image bytes |

Each persisted record now contains only operation, creation time, immutable
random key, key-salted input hash, scope hash, hashed intent-storage key, and an
explicit redaction marker. Account scopes are hashed. Scope hashes intentionally
allow comparison between keys; they are not claimed anonymous. All metadata
remains encrypted, device-local and capture-protected. Request bodies exist only
in transient screen/request memory; unsent drafts are not promised durable.

Exact original input re-entered after restart still matches its hash and uses
the original key. Edited input cannot replace it. Generic recovery no longer
reconstructs or automatically resends a body: authenticated `POST /recovery/resolve`
returns only COMMITTED or NOT_COMMITTED for the caller's original operation/key.
It takes the same lock as execution. A receipt wins if execution committed first;
otherwise a terminal fence prevents any delayed original delivery from executing.
No domain command, provider call, resource body or stored result is returned.
The UI distinguishes committed work from closed, uncommitted work requiring
re-entry. Authorization for actual resource reads and exact mutation replays is
unchanged. Private uploads still require reselecting the same original file.

## Session-ending and upgrade behavior

- New writes are redacted before reaching SecureStore, including delayed writes
  after logout. No plaintext body is restored by a late network response.
- Confirmed logout, logout-all, self-device revocation, detected remote revocation,
  invalid/uncertain refresh, and explicit forget after phone-change revocation
  invalidate the in-memory identity, write a credential-free ending marker,
  redact registered legacy queues, then delete credentials with readback.
- Immutable recovery metadata remains account-scoped for safe resolution after
  reauthentication. Logout does not silently assume an uncertain command failed.
- A failed native deletion retains cleanup pointers/registry and the ending
  marker. Restoration fails closed until cleanup succeeds. We do not report
  sensitive data deleted while the native store still contains it.
- An offline/failed logout is not successful server revocation. Its credentials
  remain available for retry, while new journal records still contain no bodies.
- Remote revocation is detected on the next authenticated call/refresh; this is
  not a push-based erase promise for an offline device.
- Registered legacy queues are redacted before credential restoration/sign-in.
  A bounded registry records scopes before new writes. A legacy scope found on
  account access is also registered and redacted before journal exposure.
- **Upgrade limit:** the old app did not index account queues and Expo SecureStore
  cannot enumerate arbitrary Keychain keys. Old, unvisited accounts cannot be
  located automatically. Production needs a reviewed legacy-key cleanup/migration
  policy; this correction does not claim blanket historical-device erasure.
  Sixteen account scopes and fifty pending records per account are bounded;
  exhausted capacity fails closed and requires support, not silent eviction.

## Verification and limits

Runtime/HTTP/PostgreSQL tests cover invalid message, stale reply, openCase's
wide scope and hold409 followed by changed dates or vehicle, through fresh runtime
instances and lost committed responses. Independent PostgreSQL connections and
barriers force both orders between execution and recovery fencing, verifying
actual lock blocking and zero/one effect. Raw SecureStore assertions use only
synthetic sensitive values, including failed deletion and each ending path.
These adapters are fixtures, not hardware-Keychain evidence.

Installed customer/host rejection flows keep their PostgreSQL uniqueness checks.
The iOS harness now waits for the loaded vehicle and enabled availability action;
it traverses the selfie waypoint before agreement acceptance. Host restarts use
the existing measured cold-Keychain readiness budget from host login, retaining
the exact dashboard assertion. Prior logs showed a late loaded dashboard after
the default restart assertion failed, not a domain mutation failure. These
changes do not establish a universal fix for historical iOS driver instability.
A subsequent customer iOS trace showed the correct native email value but a tap
on a disabled send-code button, followed by no auth HTTP request. The harness now
asserts the exact email value and selects only enabled send/verify controls.
Phone-entry flows explicitly refocus the field before each digit while retaining
every exact-prefix assertion. No assertion is removed, no failed mutation is
retried automatically, and no timeout is increased for these input barriers.

No schema/migration changes. Financial, trip, booking and private-file gates
remain intact. Live payments/payouts stay disabled; lost-phone recovery remains
review-only. Exact-SHA CI and installed results belong in the final task/PR report.
Physical devices, real providers, manual assistive technology and historical
unindexed-key cleanup remain production requirements. No merge/production approval.

## Additional review: F1, F2 and N1

F1 preserves the earlier uncertain record when a later replay receives 401, 404
or 429. Those statuses never constitute non-commit proof, even with a purported
proof field. Real HTTP/PostgreSQL regressions commit a message, lose its response,
revoke the session or membership, and retain the original key through restart.
Reauthentication to the same account can resolve only its own key's outcome;
this does not restore resource access. The endpoint returns only outcome/key,
not a receipt payload, resource ID, message, document or another account's state.
The account/operation/key namespace and execution lock are the authorization
boundary, with current credential validation repeated inside that transaction.
Process-death coverage suspends delivery after the server response but before
runtime acknowledgement, creates a new runtime, and verifies one effect. This
models process death; installed restart journeys supply separate OS evidence.

F2 raw-store assertions also include date of birth, driver name, review text and
upload reservation/label descriptors. Reviews and upload records follow the same
metadata-only retention rules. No review text, photo bytes, local image URI or
driver details are retained by the recovery journal. Existing registry/queue
bounds and account-scoped cleanup rules above apply; unknown legacy scopes and
an unavailable original upload remain explicit limitations.

N1 was confirmed by inspecting web identity, marketplace and collaboration
downloads: each authorized before storage IO but lacked a current-access recheck
afterward. They now reload current membership/actor and document authorization,
reject changed resource/storage mappings, and revalidate the effective private
object immediately before returning bytes. Shared storage validation retains
legacy-chain identity, clean/stored and deletion checks. HTTP tests pause actual
storage-provider delivery, commit removal/quarantine/deletion through another
PostgreSQL connection, observe that commit, then release IO and require no bytes.
Owner and unrelated-host controls cover all three routes, including both case
and conversation attachments. Provider bytes and web session identity are fixture
boundaries; storage validation, access policy and PostgreSQL remain real.

Customer iOS matched the case creation form's title before detail loaded. The
unchanged host rerun reached the same premature reply-field lookup: its detail
APIs finished two seconds after that lookup expired. Both journeys now require
the authoritative case-detail-title and absence of the creation form, using the
existing 60-second incident-detail completion budget for this multi-request flow.
This is a state barrier, not a sleep or an automatic submission retry.
Host iOS CFNetwork canceled a phone request at 19,889ms; server 200 arrived later.
CI precompiles the phone route with invalid input (required 400, no challenge or
provider call), using the existing setup budget. App network limits and exact
journey assertions are unchanged; this does not claim production latency solved.

The later host iOS rerun completed owner/reply/upload/return/incident and active
employee flows, but the revocation test scrolled a still-loaded dashboard before
the denial state settled. The same-session hostContext request returned 403.
Revocation acceptance now awaits the exact membership-denial message using the
existing 60-second multi-request budget (session rotation can precede the read),
then requires the access-error text and absence of employee identity and host
controls. No extra tap, mutation retry, network-timeout change or weakened denial
assertion is introduced. An earlier read timeout and variable simulator latency
remain production-stability follow-ups, not claimed fixed by this state barrier.

The next iOS run passed the complete owner and revocation-denial checks, then
failed when entering the unrelated-host login. Its device-list response inserted
a card while XCTest tapped logout using the earlier coordinates; no logout HTTP
request was recorded and the failure screenshot remained on Account. Both host
logout transitions now reuse the customer's existing 20-second loaded-device-row
barrier, center and require enabled logout, then require the signed-out welcome
screen. No logout retry, sleep or timeout increase is introduced.

## N1 browser credential follow-up

Identity-document and community attachment web routes capture the authenticated browser session ID and credential version. They validate that exact database session before reading and again after provider I/O and the existing resource/effective-storage checks, immediately before constructing the byte response. Revocation, absolute expiry, idle expiry, rotation, inactive users and missing credential context fail closed. A replacement session cannot authorize the original response. Existing membership, document identity, quarantine, deletion and legacy-chain protections remain unchanged.

The existing real HTTP/PostgreSQL web barrier regressions now use persisted browser sessions. Identity, conversation and case reads each pause provider I/O while an independent connection commits revocation, absolute expiry, idle expiry or rotation. A second independent observer confirms the change, with active user, membership and clean/stored object unchanged, before releasing the provider. Each denied request performs exactly one provider read and returns no sentinel bytes. A new valid session then reads the same unchanged resource successfully. Existing employee-removal, quarantine/deletion and unrelated-host controls are retained. Browser cookie decoding and external provider bytes are fixtures; database session validation, routes, resource authorization and storage validation are real. No timed sleep is used as race evidence.

No schema/migration or financial-gate change. Exact-commit verification is recorded on PR #10; this follow-up requires narrow independent review.
