import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { SecureRecoveryStore } from '../../../packages/mobile-client/src/secure-recovery-store';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const recoveryStore = new SecureRecoveryStore({
  get: key => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: key => SecureStore.deleteItemAsync(key, options),
}, scope => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope), () => Crypto.randomUUID());
