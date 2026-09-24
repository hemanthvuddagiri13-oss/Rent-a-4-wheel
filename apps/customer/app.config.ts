import type { ExpoConfig } from 'expo/config';
const acceptance = process.env.NATIVE_ACCEPTANCE === '1';
const hostApp = process.env.EXPO_PUBLIC_APP_MODE === 'host';
const identity = hostApp ? 'host' : 'customer';
const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? 'https://staging.renta4wheel.com';
if (acceptance && apiOrigin !== 'http://localhost:3000') throw new Error('Native acceptance builds require the local synthetic backend');
const config: ExpoConfig = {
  name: hostApp ? 'Rent A 4Wheel Host' : 'Rent A 4Wheel', slug: 'rent-a-4wheel-' + identity, version: '0.1.0',
  icon: './assets/icon.png',
  platforms: ['ios', 'android'],
  orientation: 'default', userInterfaceStyle: 'dark', scheme: hostApp ? 'renta4wheel-host' : 'renta4wheel',
  ios: { bundleIdentifier: 'com.renta4wheel.' + identity + (acceptance ? '.acceptance' : ''), supportsTablet: true, config: { usesNonExemptEncryption: false }, ...(acceptance ? { infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true, NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } } } } } : {}) },
  android: { package: 'com.renta4wheel.' + identity + (acceptance ? '.acceptance' : ''), blockedPermissions: ['android.permission.RECORD_AUDIO'] },
  androidStatusBar: { barStyle: 'light-content' },
  plugins: ['expo-secure-store', ['expo-build-properties', { android: { usesCleartextTraffic: acceptance } }], ['expo-image-picker', { cameraPermission: 'Take identity and vehicle condition photos for your reservation.', photosPermission: 'Choose a photo you want to submit for your reservation.', microphonePermission: false }]],
  extra: { apiOrigin, localAcceptance: acceptance, appMode: identity },
};
export default config;
