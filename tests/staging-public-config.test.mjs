import { test } from 'node:test';
import { deepEqual, doesNotThrow, throws } from 'node:assert/strict';
import { stagingPublicConfig, assertStagingPublicRuntime } from '../scripts/staging-public-config.mjs';
const origin = 'https://staging.compile.renta4wheel.com';
test('public build inputs preserve only staging origin and a test publishable key', () => {
  deepEqual(stagingPublicConfig({ NEXT_PUBLIC_SITE_URL: origin, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_Synthetic', STRIPE_SECRET_KEY: 'synthetic-private-never-copy' }), { siteUrl: origin, publishableKey: 'pk_test_Synthetic' });
});
test('missing, production, cleartext and secret/live build inputs are refused', () => {
  for (const address of [undefined, 'https://renta4wheel.com', 'http://staging.renta4wheel.com', origin + '/path', 'https://staging.foo.internal']) throws(() => stagingPublicConfig({ NEXT_PUBLIC_SITE_URL: address }));
  for (const key of ['sk_test_Private', 'pk_live_Forbidden']) throws(() => stagingPublicConfig({ NEXT_PUBLIC_SITE_URL: origin, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: key }));
});
test('runtime cannot silently replace frozen public origin or payment key', () => {
  const built = stagingPublicConfig({ NEXT_PUBLIC_SITE_URL: origin, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_Synthetic' });
  const runtime = { SITE_URL: origin, NEXT_PUBLIC_SITE_URL: origin, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_Synthetic' };
  doesNotThrow(() => assertStagingPublicRuntime(runtime, built));
  for (const patch of [{ SITE_URL: 'https://staging.other.renta4wheel.com' }, { NEXT_PUBLIC_SITE_URL: 'https://renta4wheel.com' }, { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_Changed' }, { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined }]) throws(() => assertStagingPublicRuntime({ ...runtime, ...patch }, built), /MISMATCH/);
});
test('credential-free compile image can start for fail-closed readiness checks', () => {
  doesNotThrow(() => assertStagingPublicRuntime({}, stagingPublicConfig({ NEXT_PUBLIC_SITE_URL: origin })));
});
