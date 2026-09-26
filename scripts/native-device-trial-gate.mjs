// Run before packaging an app for installation on a physical device.
// CI's synthetic, loopback acceptance binaries must never be distributed.
export function deviceTrialProblems(env) {
  const problems = [];
  if (env.APP_ENV !== 'staging') problems.push('APP_ENV must be staging');
  if (env.NATIVE_ACCEPTANCE !== '0') problems.push('NATIVE_ACCEPTANCE must explicitly be 0');
  if (!['customer', 'host'].includes(env.EXPO_PUBLIC_APP_MODE)) problems.push('app mode must be customer or host');
  if (env.ALLOW_DEV_PAYMENT_SIMULATION !== 'false') problems.push('development payment simulation must be disabled');
  if (env.LIVE_FINANCE_ENABLED !== 'false') problems.push('live finance must be disabled');
  if (!env.MOBILE_SMS_PROVIDER || env.MOBILE_SMS_PROVIDER === 'fixture' || env.MOBILE_SMS_FIXTURE_CODE) problems.push('a non-fixture SMS provider must be configured');

  try {
    const origin = new URL(env.EXPO_PUBLIC_API_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || origin.port) {
      problems.push('API origin must be a bare HTTPS origin');
    }
    const host = origin.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.invalid') || host.endsWith('.test') || host.endsWith('.example') || host === '127.0.0.1' || host === '[::1]' || host === 'renta4wheel.com' || (host.endsWith('.renta4wheel.com') && host !== 'staging.renta4wheel.com')) {
      problems.push('API origin must be an isolated, non-production staging host');
    }
  } catch {
    problems.push('EXPO_PUBLIC_API_ORIGIN must be explicitly configured');
  }
  return problems;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const problems = deviceTrialProblems(process.env);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`Device trial blocked: ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Device trial configuration passed local safety checks. Deployment and distribution still require independent verification.\n');
  }
}
