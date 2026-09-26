import { test } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const cwd = fileURLToPath(new URL('../apps/customer', import.meta.url));
const base = { ...process.env, EXPO_NO_TELEMETRY: '1', CI: 'true', APP_ENV: 'staging', NATIVE_ACCEPTANCE: '0', EXPO_PUBLIC_API_ORIGIN: 'https://staging.compile.renta4wheel.com', DEVICE_TRIAL_STAGING_ORIGIN: 'https://staging.compile.renta4wheel.com', ALLOW_DEV_PAYMENT_SIMULATION: 'false', LIVE_FINANCE_ENABLED: 'false', MOBILE_SMS_PROVIDER: 'twilio', MOBILE_SMS_FIXTURE_CODE: '' };
function config(env) { return spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'config', '--type', 'public', '--json'], { cwd, env, encoding: 'utf8', timeout: 60000, windowsHide: true }); }
for (const mode of ['customer', 'host']) test(`real Expo config isolates ${mode} trial and forbids cleartext`, () => {
  const result = config({ ...base, EXPO_PUBLIC_APP_MODE: mode });
  equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout);
  equal(app.ios.bundleIdentifier, `com.renta4wheel.${mode}.trial`);
  equal(app.android.package, `com.renta4wheel.${mode}.trial`);
  equal(app.extra.localAcceptance, false);
  equal(app.extra.apiOrigin, base.EXPO_PUBLIC_API_ORIGIN);
  ok(!app.ios.infoPlist?.NSAppTransportSecurity);
  const props = app.plugins.find(p => Array.isArray(p) && p[0] === 'expo-build-properties')[1];
  equal(props.android.usesCleartextTraffic, false);
  equal(props.android.buildArchs.join(','), 'arm64-v8a');
});
test('direct Expo invocation cannot bypass missing or unsafe trial configuration', () => {
  for (const patch of [{ APP_ENV: '' }, { LIVE_FINANCE_ENABLED: 'true' }, { EXPO_PUBLIC_API_ORIGIN: 'https://renta4wheel.com' }, { MOBILE_SMS_PROVIDER: 'fixture' }]) {
    const result = config({ ...base, EXPO_PUBLIC_APP_MODE: 'customer', ...patch });
    ok(result.status !== 0); ok(result.stderr.includes('Device trial blocked'));
  }
});
test('existing loopback simulator configuration remains separate', () => {
  const result = config({ ...base, EXPO_PUBLIC_APP_MODE: 'host', APP_ENV: 'test', NATIVE_ACCEPTANCE: '1', EXPO_PUBLIC_API_ORIGIN: 'http://localhost:3000' });
  equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout); equal(app.android.package, 'com.renta4wheel.host.acceptance'); equal(app.extra.localAcceptance, true);
});

const trialPlugin = createRequire(import.meta.url)('../apps/customer/plugins/with-unsigned-trial.cjs');
async function releaseContents(contents) {
  const config = trialPlugin({});
  const result = await config.mods.android.appBuildGradle({ modResults: { contents }, modRequest: {} });
  return result.modResults.contents;
}
test('release signing mod stays unsigned across repeated real Expo mod execution', async () => {
  const debug = 'debug {\n signingConfig signingConfigs.debug\n}\n';
  const first = await releaseContents(debug + 'release {\n // Expo release template\n signingConfig signingConfigs.debug\n minifyEnabled true\n}');
  ok(first.startsWith(debug));
  ok(first.includes('release {\n // Expo release template\n signingConfig null\n'));
  equal(await releaseContents(first), first);
});
test('release signing mod still refuses unknown or private-key templates', async () => {
  for (const value of ['signingConfigs.privateTrial', 'signingConfigs.debugOther', 'nullOther', '']) {
    await rejects(releaseContents('release {\n signingConfig ' + value + '\n}'), /Unknown Android release signing template/);
  }
});
