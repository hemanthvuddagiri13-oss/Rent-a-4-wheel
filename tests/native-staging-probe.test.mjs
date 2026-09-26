import { test } from 'node:test';
import { equal, rejects } from 'node:assert/strict';
import { probeNativeStaging } from '../scripts/native-staging-probe.mjs';

const env = { APP_ENV: 'staging', NATIVE_ACCEPTANCE: '0', EXPO_PUBLIC_APP_MODE: 'customer', ALLOW_DEV_PAYMENT_SIMULATION: 'false', LIVE_FINANCE_ENABLED: 'false', MOBILE_SMS_PROVIDER: 'twilio', EXPO_PUBLIC_API_ORIGIN: 'https://staging.renta4wheel.com' };
const good = { '/api/health/live': { live: true }, '/api/health/ready': { ready: true }, '/api/v1/mobile/vehicles': { data: { items: [] }, error: null, requestId: 'fixture-id' } };
function fake(body = good, status = 200, origin = 'https://staging.renta4wheel.com') {
  return async (url, options) => {
    equal(options.method, 'GET');
    equal(options.redirect, 'manual');
    const path = new URL(url).pathname;
    return { status, url: origin + path, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body[path] };
  };
}

test('checks deployed readiness and the public mobile API without mutations', async () => {
  equal(await probeNativeStaging(env, fake()), true);
});

test('denies redirects, unhealthy readiness and local synthetic targets', async () => {
  await rejects(probeNativeStaging(env, fake(good, 302)), /unexpected status/);
  await rejects(probeNativeStaging(env, fake(good, 200, 'https://other.example.org')), /unexpected status or origin/);
  await rejects(probeNativeStaging(env, fake({ ...good, '/api/health/ready': { ready: false } })), /unhealthy/);
  await rejects(probeNativeStaging({ ...env, EXPO_PUBLIC_API_ORIGIN: 'http://localhost:3000' }, fake()), /configuration blocked/);
});
