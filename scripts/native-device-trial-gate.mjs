// Run before packaging an app for installation on a physical device.
// CI's synthetic, loopback acceptance binaries must never be distributed.
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
export function deviceTrialProblems(env) {
  const problems = [];
  if (env.APP_ENV !== 'staging') problems.push('APP_ENV must be staging');
  if (env.NATIVE_ACCEPTANCE !== '0') problems.push('NATIVE_ACCEPTANCE must explicitly be 0');
  if (!['customer', 'host'].includes(env.EXPO_PUBLIC_APP_MODE)) problems.push('app mode must be customer or host');
  if (env.ALLOW_DEV_PAYMENT_SIMULATION !== 'false') problems.push('development payment simulation must be disabled');
  if (env.LIVE_FINANCE_ENABLED !== 'false') problems.push('live finance must be disabled');
  if (env.MOBILE_SMS_PROVIDER !== 'twilio' || env.MOBILE_SMS_FIXTURE_CODE) problems.push('a supported non-fixture SMS provider must be configured');

  try {
    const origin = new URL(env.EXPO_PUBLIC_API_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || origin.port) {
      problems.push('API origin must be a bare HTTPS origin');
    }
    const host = origin.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /\.(localhost|local|internal|invalid|test|example)$/.test(host) || /^(www\.)?(renta4wheel|rentafourwheel)\.com$/.test(host) || !host.startsWith('staging.')) {
      problems.push('API origin must be an isolated, non-production staging host');
    }
    // An explicit operator-selected origin prevents ambient Expo variables from
    // choosing another backend. This is NOT proof of DNS/account isolation.
    if (env.DEVICE_TRIAL_STAGING_ORIGIN !== origin.origin || env.EXPO_PUBLIC_API_ORIGIN !== origin.origin) problems.push('API origin must exactly match DEVICE_TRIAL_STAGING_ORIGIN');
  } catch {
    problems.push('EXPO_PUBLIC_API_ORIGIN must be explicitly configured');
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = deviceTrialProblems(process.env);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`Device trial blocked: ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Device trial configuration passed local safety checks. Deployment and distribution still require independent verification.\n');
  }
}
