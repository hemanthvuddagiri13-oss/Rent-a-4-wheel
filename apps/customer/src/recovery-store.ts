import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { RecoveryStore } from '../../../packages/mobile-client/src/recovery';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
type Pointer = { generation: string; count: number };
/** Small encrypted Keychain/Keystore entries; publish the pointer only after all
 * chunks persist. A process crash can leave unreachable encrypted chunks, never
 * a partially dispatched request. No image bytes or credentials belong here. */
export const recoveryStore: RecoveryStore = {
  async read(scope) {
    const key = 'ra4w.recovery.' + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
    const raw = await SecureStore.getItemAsync(key, options); if (!raw) return null;
    const pointer = JSON.parse(raw) as Pointer;
    if (!/^[a-zA-Z0-9-]+$/.test(pointer.generation) || !Number.isInteger(pointer.count) || pointer.count < 1 || pointer.count > 10000) throw new Error('Invalid secure recovery pointer');
    let value = '';
    for (let i = 0; i < pointer.count; i++) { const part = await SecureStore.getItemAsync(key + '.' + pointer.generation + '.' + i, options); if (part === null) throw new Error('Incomplete secure recovery record'); value += part; }
    return value;
  },
  async write(scope, value) {
    const key = 'ra4w.recovery.' + await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
    const prior = await SecureStore.getItemAsync(key, options);
    const generation = Crypto.randomUUID(), points = Array.from(value), chunks: string[] = [];
    for (let offset = 0; offset < points.length; offset += 300) chunks.push(points.slice(offset, offset + 300).join(''));
    if (!chunks.length) chunks.push('');
    if (chunks.length > 10000) throw new Error('Secure recovery capacity exceeded');
    for (let i = 0; i < chunks.length; i++) await SecureStore.setItemAsync(key + '.' + generation + '.' + i, chunks[i], options);
    await SecureStore.setItemAsync(key, JSON.stringify({ generation, count: chunks.length }), options);
    if (prior) { const old = JSON.parse(prior) as Pointer; for (let i = 0; i < old.count; i++) await SecureStore.deleteItemAsync(key + '.' + old.generation + '.' + i, options).catch(() => {}); }
  },
};
