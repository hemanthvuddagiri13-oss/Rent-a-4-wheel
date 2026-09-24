import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { createMobileClient, MobileApiError, type MobileOperations } from '../../../packages/mobile-client/src';
import { Session, SignInRequired } from './session';
import { boundedFetch } from './transport';
import { RecoveryJournal, RecoveryConflict, IntentKeys, type RecoveryRecord } from '../../../packages/mobile-client/src/recovery';
import { recoveryStore } from './recovery-store';
export type Output<K extends keyof MobileOperations> = MobileOperations[K]['output'];
export const origin: string = Constants.expoConfig?.extra?.apiOrigin;
export const hostApp = Constants.expoConfig?.extra?.appMode === 'host';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
class SecureStorageUnavailable extends Error {}
async function secureStorage<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch { throw new SecureStorageUnavailable('Secure device storage is unavailable. Unlock your device and retry. If this continues, contact support.'); }
}
export const vault = { get: () => secureStorage(() => SecureStore.getItemAsync('ra4w.session', options)), set: (v: string) => secureStorage(() => SecureStore.setItemAsync('ra4w.session', v, options)), clear: () => secureStorage(() => SecureStore.deleteItemAsync('ra4w.session', options)) };
const localAcceptance = Constants.expoConfig?.extra?.localAcceptance === true && origin === 'http://localhost:3000';
export const session = new Session(vault, origin, boundedFetch, localAcceptance);
const recovery = new RecoveryJournal(recoveryStore);
// Auth challenges/ownership changes are deliberately not a replayable outbox.
// Upload bytes use their descriptor-only coordinator below.
const recoverable = new Set<keyof MobileOperations>(['hold', 'checkout', 'hostAvailability', 'openConversation', 'saveReview', 'sendMessage', 'replyCase', 'openCase', 'submitReport', 'acceptReport', 'hostHandoff', 'tripStart', 'tripReturn', 'tripCancel', 'tripKeys', 'tripComplete']);
export async function pendingRequests() { const assertIdentity = session.captureIdentity(), me = await session.call('me', {}); const records = await recovery.list(me.id); assertIdentity(); return records; }
export async function recoverRequest(record: RecoveryRecord) {
  const assertIdentity = session.captureIdentity(), me = await session.call('me', {});
  if (!recoverable.has(record.operation as keyof MobileOperations)) throw new Error('This request requires its original screen.');
  const persisted = (await recovery.list(me.id)).find(r => r.key === record.key);
  if (!persisted) throw new Error('This request is no longer pending. Refresh recovery.');
  const result = await recovery.execute(me.id, persisted, async frozen => { assertIdentity(); return session.call(frozen.operation as keyof MobileOperations, { ...(frozen.input as object), idempotencyKey: frozen.key } as MobileOperations[keyof MobileOperations]['input']); });
  await acknowledgeIntent(me.id + ':' + persisted.operation, persisted.input, persisted.key).catch(() => {});
  assertIdentity(); return result;
}
export async function uploadWithRecovery(descriptor: MobileOperations['initializeUpload']['input']['body'], label: string, bytes: Uint8Array) {
  const assertIdentity = session.captureIdentity(), me = await session.call('me', {});
  const input = { params: { id: descriptor.reservationId, type: descriptor.type, label }, body: descriptor };
  const key = await intentKey(me.id + ':privateUpload', input);
  return recovery.execute(me.id, { key, operation: 'privateUpload', input, createdAt: new Date().toISOString() }, async () => {
    assertIdentity();
    const initialized = await mutate('initializeUpload', { body: descriptor });
    const result = await mutate('finalizeUpload', { params: { id: initialized.id }, body: bytes, contentType: descriptor.mimeType });
    return { documentId: result.id, uploadId: initialized.id };
  });
}
export const publicApi = createMobileClient({ baseUrl: origin, accessToken: async () => null, fetch: boundedFetch, allowLocalHttp: localAcceptance });
export async function deviceId() {
  const saved = await secureStorage(() => SecureStore.getItemAsync('ra4w.device', options)); if (saved) return saved;
  const id = Crypto.randomUUID(); await secureStorage(() => SecureStore.setItemAsync('ra4w.device', id, options)); return id;
}
const intentKeys = new IntentKeys({ get: key => SecureStore.getItemAsync(key, options), set: (key, value) => SecureStore.setItemAsync(key, value, options), remove: key => SecureStore.deleteItemAsync(key, options) }, () => Crypto.randomUUID());
async function intentStorageKey(operation: string, input: unknown) { return 'ra4w.intent.' + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, operation + ':' + JSON.stringify(input)); }
async function acknowledgeIntent(operation: string, input: unknown, value: string) { await intentKeys.acknowledge(await intentStorageKey(operation, input), value); }
/** Persist only hashes and random keys, never driver details, photos or message text. */
export async function intentKey(operation: string, input: unknown): Promise<string> { return intentKeys.get(await intentStorageKey(operation, input)); }
export async function mutate<K extends keyof MobileOperations>(op: K, input: Omit<MobileOperations[K]['input'], 'idempotencyKey'>): Promise<Output<K>> {
  // Freeze before the first await: screen edits cannot change the dispatched
  // body after its fingerprint or durable record has been written.
  const originalBody = (input as { body?: unknown }).body;
  input = originalBody instanceof Uint8Array ? { ...input, body: new Uint8Array(originalBody) } : JSON.parse(JSON.stringify(input));
  // Include account/session identity so an interrupted request cannot cross accounts.
  const assertIdentity = session.captureIdentity();
  const me = await session.call('me', {});
  const body = (input as { body?: unknown }).body;
  const fingerprint = body instanceof Uint8Array ? { ...input, body: Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(body)))).map(b => b.toString(16).padStart(2, '0')).join('') } : input;
  const scope = me.id + ':' + op;
  const idempotencyKey = await intentKey(scope, fingerprint);
  assertIdentity();
  const dispatch = () => { assertIdentity(); return session.call(op, { ...input, idempotencyKey } as MobileOperations[K]['input']); };
  const result = recoverable.has(op)
    ? await recovery.execute(me.id, { key: idempotencyKey, operation: op, input, createdAt: new Date().toISOString() }, frozen => { assertIdentity(); return session.call(op, { ...(frozen.input as object), idempotencyKey: frozen.key } as MobileOperations[K]['input']); })
    : await dispatch();
  // Preserve initialization identity across a later failed finalize. Other completed
  // intentions can be submitted anew; uncertain attempts keep their original key.
  if (op !== 'initializeUpload') {
    // A delayed acknowledgement must not erase a newer attempt's key.
    await acknowledgeIntent(scope, fingerprint, idempotencyKey).catch(() => {});
  }
  return result;
}
export function friendly(error: unknown) {
  if (error instanceof RecoveryConflict) return 'An earlier request is awaiting confirmation. Open Account → Interrupted requests and recover it before changing this action.';
  if (error instanceof SecureStorageUnavailable) return error.message;
  if (error instanceof SignInRequired) return error.message;
  if (error instanceof MobileApiError) {
    const messages: Record<string, string> = { UNAUTHORIZED: 'Sign in again to continue.', FORBIDDEN: 'This action is not available for your current access.', NOT_FOUND: 'This item is no longer available.', CONFLICT: 'The server state changed. Refresh and review before trying again.', RATE_LIMITED: 'Too many requests. Wait a minute before trying again.', UNAVAILABLE: 'This service is currently unavailable. Your booking is not confirmed.', INVALID_REQUEST: 'Check the information you entered and try again.' };
    return (messages[error.code] ?? 'Unable to complete this request.') + (error.requestId ? ` Reference: ${error.requestId}` : '');
  }
  return 'Connection interrupted. Nothing is assumed complete. Reconnect and retry the same request to safely recover.';
}
