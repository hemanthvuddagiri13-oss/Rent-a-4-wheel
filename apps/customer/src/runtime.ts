import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { createMobileClient, MobileApiError, type MobileOperations } from '../../../packages/mobile-client/src';
import { Session, SignInRequired } from './session';
import { boundedFetch } from './transport';
import { RecoveryConflict, IntentKeys } from '../../../packages/mobile-client/src/recovery';
import { createMutationRuntime } from '../../../packages/mobile-client/src/mutation-runtime';
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
export const vault = { get: () => secureStorage(() => SecureStore.getItemAsync('ra4w.session', options)), set: (v: string) => secureStorage(() => SecureStore.setItemAsync('ra4w.session', v, options)), clear: () => secureStorage(async () => { await SecureStore.deleteItemAsync('ra4w.session', options); if (await SecureStore.getItemAsync('ra4w.session', options) !== null) throw new Error('Credential cleanup remains pending'); }) };
const localAcceptance = Constants.expoConfig?.extra?.localAcceptance === true && origin === 'http://localhost:3000';
export const session = new Session(vault, origin, boundedFetch, localAcceptance);
export const publicApi = createMobileClient({ baseUrl: origin, accessToken: async () => null, fetch: boundedFetch, allowLocalHttp: localAcceptance });
export async function deviceId() {
  const saved = await secureStorage(() => SecureStore.getItemAsync('ra4w.device', options)); if (saved) return saved;
  const id = Crypto.randomUUID(); await secureStorage(() => SecureStore.setItemAsync('ra4w.device', id, options)); return id;
}
const intentKeys = new IntentKeys({ get: key => SecureStore.getItemAsync(key, options), set: (key, value) => SecureStore.setItemAsync(key, value, options), remove: key => SecureStore.deleteItemAsync(key, options) }, () => Crypto.randomUUID());
export const { mutate, pendingRequests, recoverRequest, uploadWithRecovery, intentKey } = createMutationRuntime({
  session, store: recoveryStore, intentKeys,
  hashString: value => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  hashBytes: async value => Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(value)))).map(b => b.toString(16).padStart(2, '0')).join(''),
});
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
