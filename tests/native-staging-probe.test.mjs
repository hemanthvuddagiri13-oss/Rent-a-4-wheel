import { test } from 'node:test';
import { equal, rejects } from 'node:assert/strict';
import { probeNativeStaging } from '../scripts/native-staging-probe.mjs';

const env = { APP_ENV: 'staging', NATIVE_ACCEPTANCE: '0', EXPO_PUBLIC_APP_MODE: 'customer', ALLOW_DEV_PAYMENT_SIMULATION: 'false', LIVE_FINANCE_ENABLED: 'false', MOBILE_SMS_PROVIDER: 'twilio', EXPO_PUBLIC_API_ORIGIN: 'https://staging.renta4wheel.com', DEVICE_TRIAL_STAGING_ORIGIN: 'https://staging.renta4wheel.com' };
const id = '00000000-0000-4000-8000-000000000001';
const good = { '/api/health/live': { live: true }, '/api/health/ready': { ready: true }, '/api/v1/mobile/vehicles': { data: { items: [], nextCursor: null }, error: null, requestId: id } };
function fake(body = good, status = 200, origin = 'https://staging.renta4wheel.com', headers = {}) {
  return async (url, options) => {
    equal(options.method, 'GET');
    equal(options.redirect, 'manual');
    const path = new URL(url).pathname;
    const response = new Response(JSON.stringify(body[path]), { status, headers: { 'content-type': 'application/json', 'x-api-version': '1', 'x-request-id': id, ...headers } });
    Object.defineProperty(response, 'url', { value: origin + path });
    return response;
  };
}

test('checks deployed readiness and the public mobile API without mutations', async () => {
  equal(await probeNativeStaging(env, fake()), true);
});

test('rejects missing catalog data, invalid envelopes and mismatched contract headers', async () => {
  for (const data of [undefined, null, {}, { items: null }, { items: [], nextCursor: 7 }]) {
    await rejects(probeNativeStaging(env, fake({ ...good, '/api/v1/mobile/vehicles': { data, error: null, requestId: id } })), /unhealthy/);
  }
  await rejects(probeNativeStaging(env, fake(good, 200, env.EXPO_PUBLIC_API_ORIGIN, { 'x-api-version': '2' })), /headers/);
  await rejects(probeNativeStaging(env, fake(good, 200, env.EXPO_PUBLIC_API_ORIGIN, { 'x-request-id': 'wrong' })), /headers/);
  await rejects(probeNativeStaging(env, fake(good, 200, env.EXPO_PUBLIC_API_ORIGIN, { 'content-type': 'text/application/json' })), /JSON/);
});

test('bounds response bodies and fails closed on interrupted delivery', async () => {
  await rejects(probeNativeStaging(env, fake({ ...good, '/api/health/live': { live: true, padding: 'x'.repeat(262145) } })), /oversized/);
  await rejects(probeNativeStaging(env, async () => { throw new Error('synthetic network loss'); }));
});

test('denies redirects, unhealthy readiness and local synthetic targets', async () => {
  await rejects(probeNativeStaging(env, fake(good, 302)), /unexpected status/);
  await rejects(probeNativeStaging(env, fake(good, 200, 'https://other.example.org')), /unexpected status or origin/);
  await rejects(probeNativeStaging(env, fake({ ...good, '/api/health/ready': { ready: false } })), /unhealthy/);
  await rejects(probeNativeStaging({ ...env, EXPO_PUBLIC_API_ORIGIN: 'http://localhost:3000' }, fake()), /configuration blocked/);
});
