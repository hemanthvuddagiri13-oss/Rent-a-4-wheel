import { test } from 'node:test';
import { deepEqual, ok } from 'node:assert/strict';
import { deviceTrialProblems } from '../scripts/native-device-trial-gate.mjs';

const staging = { APP_ENV: 'staging', NATIVE_ACCEPTANCE: '0', EXPO_PUBLIC_APP_MODE: 'customer', ALLOW_DEV_PAYMENT_SIMULATION: 'false', LIVE_FINANCE_ENABLED: 'false', MOBILE_SMS_PROVIDER: 'twilio', EXPO_PUBLIC_API_ORIGIN: 'https://staging.renta4wheel.com', DEVICE_TRIAL_STAGING_ORIGIN: 'https://staging.renta4wheel.com' };

test('only explicit isolated staging configuration passes local checks', () => {
  deepEqual(deviceTrialProblems(staging), []);
});

test('rejects IP literals, alternate production names and ambient backend changes', () => {
  for (const origin of ['https://10.0.0.1', 'https://192.168.1.1', 'https://[::1]', 'https://[fc00::1]', 'https://127.1', 'https://rentafourwheel.com', 'https://www.rentafourwheel.com', 'https://renta4wheel.com.', 'https://staging.local', 'https://api.other.org']) {
    ok(deviceTrialProblems({ ...staging, EXPO_PUBLIC_API_ORIGIN: origin, DEVICE_TRIAL_STAGING_ORIGIN: origin }).length > 0, origin);
  }
  ok(deviceTrialProblems({ ...staging, EXPO_PUBLIC_API_ORIGIN: 'https://staging.other.org' }).length);
  ok(deviceTrialProblems({ ...staging, MOBILE_SMS_PROVIDER: 'unknown' }).length);
});

test('rejects synthetic acceptance builds and finance fixtures', () => {
  const errors = deviceTrialProblems({ ...staging, NATIVE_ACCEPTANCE: '1', LIVE_FINANCE_ENABLED: 'true', MOBILE_SMS_PROVIDER: 'fixture' });
  ok(errors.some(error => error.includes('NATIVE_ACCEPTANCE')));
  ok(errors.some(error => error.includes('finance')));
  ok(errors.some(error => error.includes('non-fixture')));
});

test('rejects local, production, malformed and non-HTTPS origins', () => {
  for (const origin of ['http://localhost:3000', 'https://renta4wheel.com', 'https://www.renta4wheel.com', 'https://staging.example.invalid', 'https://staging.example.test', 'https://staging.renta4wheel.com/path', 'https://user:pass@staging.renta4wheel.com', '']) {
    ok(deviceTrialProblems({ ...staging, EXPO_PUBLIC_API_ORIGIN: origin }).length > 0, origin);
  }
});
