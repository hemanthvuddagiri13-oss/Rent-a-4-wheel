import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { createMobileClient, MobileApiError, type MobileOperations } from '../../../packages/mobile-client/src';
import { Session, SignInRequired } from './session';
import { boundedFetch } from './transport';
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
export const publicApi = createMobileClient({ baseUrl: origin, accessToken: async () => null, fetch: boundedFetch, allowLocalHttp: localAcceptance });
export async function deviceId() {
  const saved = await secureStorage(() => SecureStore.getItemAsync('ra4w.device', options)); if (saved) return saved;
  const id = Crypto.randomUUID(); await secureStorage(() => SecureStore.setItemAsync('ra4w.device', id, options)); return id;
}
let intentTail: Promise<unknown> = Promise.resolve();
/** Persist only hashes and random keys, never driver details, photos or message text. */
export function intentKey(operation: string, input: unknown): Promise<string> {
  const work = intentTail.then(async () => {
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, operation + ':' + JSON.stringify(input));
    const key = 'ra4w.intent.' + hash;
    const existing = await SecureStore.getItemAsync(key, options); if (existing) return existing;
    const value = Crypto.randomUUID(); await SecureStore.setItemAsync(key, value, options); return value;
  }); intentTail = work.catch(() => {}); return work;
}
export async function mutate<K extends keyof MobileOperations>(op: K, input: Omit<MobileOperations[K]['input'], 'idempotencyKey'>): Promise<Output<K>> {
  // Include account/session identity so an interrupted request cannot cross accounts.
  const assertIdentity = session.captureIdentity();
  const me = await session.call('me', {});
  const body = (input as { body?: unknown }).body;
  const fingerprint = body instanceof Uint8Array ? { ...input, body: Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(body)))).map(b => b.toString(16).padStart(2, '0')).join('') } : input;
  const scope = me.id + ':' + op;
  const idempotencyKey = await intentKey(scope, fingerprint);
  assertIdentity();
  const result = await session.call(op, { ...input, idempotencyKey } as MobileOperations[K]['input']);
  // Preserve initialization identity across a later failed finalize. Other completed
  // intentions can be submitted anew; uncertain attempts keep their original key.
  if (op !== 'initializeUpload') {
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope + ':' + JSON.stringify(fingerprint));
    await SecureStore.deleteItemAsync('ra4w.intent.' + hash, options).catch(() => {});
  }
  return result;
}
export function friendly(error: unknown) {
  if (error instanceof SecureStorageUnavailable) return error.message;
  if (error instanceof SignInRequired) return error.message;
  if (error instanceof MobileApiError) {
    const messages: Record<string, string> = { UNAUTHORIZED: 'Sign in again to continue.', FORBIDDEN: 'This action is not available for your current access.', NOT_FOUND: 'This item is no longer available.', CONFLICT: 'The server state changed. Refresh and review before trying again.', RATE_LIMITED: 'Too many requests. Wait a minute before trying again.', UNAVAILABLE: 'This service is currently unavailable. Your booking is not confirmed.', INVALID_REQUEST: 'Check the information you entered and try again.' };
    return (messages[error.code] ?? 'Unable to complete this request.') + (error.requestId ? ` Reference: ${error.requestId}` : '');
  }
  return 'Connection interrupted. Nothing is assumed complete. Reconnect and retry the same request to safely recover.';
}
