import type { MobileOperations } from './index';
import type { Session } from './session';
import { RecoveryJournal, IntentKeys, type RecoveryRecord, type RecoveryStore } from './recovery';
import { protectRecovery } from './recovery-privacy';
import { mutationOperations, type RecoverableOperation } from './mutation-operations';
import { MobileApiError } from './index';
type Output<K extends keyof MobileOperations> = MobileOperations[K]['output'];
/** Production runtime; only device adapters are injected, not mutation policy. */
export function createMutationRuntime({ session, store, intentKeys, hashString, hashBytes }: {
  session: Session; store: RecoveryStore; intentKeys: IntentKeys;
  hashString(value: string): Promise<string>; hashBytes(value: Uint8Array): Promise<string>;
}) {
const protect = (value: string) => protectRecovery(value, hashString);
const cleanup = async () => { await store.rewriteKnown?.(protect); };
session.beforeRestore = cleanup; session.onEnd = cleanup;
const recovery = new RecoveryJournal({
  read: async scope => { const value = await store.read(scope); if (value === null) return null; const clean = await protect(value); if (clean !== value) await store.write(scope, clean); return clean; },
  write: async (scope, value) => store.write(scope, await protect(value)),
});
// Auth challenges/ownership changes are deliberately not a replayable outbox.
// Upload bytes use their descriptor-only coordinator below.
const recoverable = new Set<string>(Object.keys(mutationOperations));
async function record(key: string, operation: string, input: unknown, scope: string): Promise<RecoveryRecord> {
  return { key, operation, input, createdAt: new Date().toISOString(), inputHash: await hashString(key + ':' + JSON.stringify(input)), scopeHash: await hashString(operation + ':' + JSON.stringify((input as { params?: unknown })?.params)), intentStorageKey: await intentStorageKey(scope, input) };
}
async function pendingRequests() { const assertIdentity = session.captureIdentity(), me = await session.call('me', {}); const records = await recovery.list(me.id); assertIdentity(); return records; }
async function recoverRequest(record: RecoveryRecord) {
  const assertIdentity = session.captureIdentity(), me = await session.call('me', {});
  if (!recoverable.has(record.operation as keyof MobileOperations)) throw new Error('This request requires its original screen.');
  const persisted = (await recovery.list(me.id)).find(r => r.key === record.key);
  if (!persisted) throw new Error('This request is no longer pending. Refresh recovery.');
  const result = await recovery.execute(me.id, persisted, async frozen => {
    assertIdentity();
    const settled = await session.call('resolveMutation', { body: { operation: frozen.operation as RecoverableOperation, idempotencyKey: frozen.key } });
    if (settled.idempotencyKey !== frozen.key || !['COMMITTED', 'NOT_COMMITTED'].includes(settled.outcome)) throw new Error('Recovery response does not match original request');
    return settled;
  });
  if (persisted.intentStorageKey) await intentKeys.acknowledge(persisted.intentStorageKey, persisted.key).catch(() => {});
  assertIdentity(); return result;
}
async function uploadWithRecovery(descriptor: MobileOperations['initializeUpload']['input']['body'], label: string, bytes: Uint8Array) {
  const assertIdentity = session.captureIdentity(), me = await session.call('me', {});
  const input = { params: { id: descriptor.reservationId, type: descriptor.type, label }, body: descriptor };
  const key = await intentKey(me.id + ':privateUpload', input);
  return recovery.execute(me.id, await record(key, 'privateUpload', input, me.id + ':privateUpload'), async () => {
    assertIdentity();
    const initialized = await mutate('initializeUpload', { body: descriptor });
    const result = await mutate('finalizeUpload', { params: { id: initialized.id }, body: bytes, contentType: descriptor.mimeType });
    return { documentId: result.id, uploadId: initialized.id };
  });
}
async function intentStorageKey(operation: string, input: unknown) { return 'ra4w.intent.' + await hashString(operation + ':' + JSON.stringify(input)); }
async function acknowledgeIntent(operation: string, input: unknown, value: string) { await intentKeys.acknowledge(await intentStorageKey(operation, input), value); }
/** Persist only hashes and random keys, never driver details, photos or message text. */
async function intentKey(operation: string, input: unknown): Promise<string> { return intentKeys.get(await intentStorageKey(operation, input)); }
async function mutate<K extends keyof MobileOperations>(op: K, input: Omit<MobileOperations[K]['input'], 'idempotencyKey'>): Promise<Output<K>> {
  // Freeze before the first await: screen edits cannot change the dispatched
  // body after its fingerprint or durable record has been written.
  const originalBody = (input as { body?: unknown }).body;
  input = originalBody instanceof Uint8Array ? { ...input, body: new Uint8Array(originalBody) } : JSON.parse(JSON.stringify(input));
  // Include account/session identity so an interrupted request cannot cross accounts.
  const assertIdentity = session.captureIdentity();
  const me = await session.call('me', {});
  const body = (input as { body?: unknown }).body;
  const fingerprint = body instanceof Uint8Array ? { ...input, body: await hashBytes(new Uint8Array(body)) } : input;
  const scope = me.id + ':' + op;
  const idempotencyKey = await intentKey(scope, fingerprint);
  assertIdentity();
  const dispatch = () => { assertIdentity(); return session.call(op, { ...input, idempotencyKey } as MobileOperations[K]['input']); };
  let result: Output<K>;
  try { result = recoverable.has(op)
    ? await recovery.execute(me.id, await record(idempotencyKey, op, input, scope), frozen => { assertIdentity(); return session.call(op, { ...(frozen.input as object), idempotencyKey: frozen.key } as MobileOperations[K]['input']); })
    : await dispatch(); }
  catch (error) {
    if (error instanceof MobileApiError && error.nonCommitKey === idempotencyKey) await acknowledgeIntent(scope, fingerprint, idempotencyKey);
    throw error;
  }
  // Preserve initialization identity across a later failed finalize. Other completed
  // intentions can be submitted anew; uncertain attempts keep their original key.
  if (op !== 'initializeUpload') {
    // A delayed acknowledgement must not erase a newer attempt's key.
    await acknowledgeIntent(scope, fingerprint, idempotencyKey).catch(() => {});
  }
  return result;
}

return { mutate, pendingRequests, recoverRequest, uploadWithRecovery, intentKey };
}
