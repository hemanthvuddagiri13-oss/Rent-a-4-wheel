import { deviceTrialProblems } from './native-device-trial-gate.mjs';

// Read-only deployment smoke check. Passing does not certify providers, data
// isolation, or physical-device security; the server's readiness check covers
// only its configured runtime dependencies.
export async function probeNativeStaging(env, request = fetch) {
  const problems = deviceTrialProblems(env);
  if (problems.length) throw new Error(`Device trial configuration blocked: ${problems.join('; ')}`);
  const origin = new URL(env.EXPO_PUBLIC_API_ORIGIN).origin;
  for (const [path, valid] of [
    ['/api/health/live', body => body?.live === true],
    ['/api/health/ready', body => body?.ready === true],
    ['/api/v1/mobile/vehicles', body => body?.error === null && body?.data !== null && typeof body?.requestId === 'string'],
  ]) {
    const response = await request(origin + path, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
    if (response.status !== 200 || new URL(response.url).origin !== origin) throw new Error(`Staging check failed: ${path} returned an unexpected status or origin`);
    const type = response.headers.get('content-type') ?? '';
    if (!type.toLowerCase().includes('application/json')) throw new Error(`Staging check failed: ${path} did not return JSON`);
    let body;
    try { body = await response.json(); } catch { throw new Error(`Staging check failed: ${path} returned invalid JSON`); }
    if (!valid(body)) throw new Error(`Staging check failed: ${path} returned an unhealthy response`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  probeNativeStaging(process.env).then(() => process.stdout.write('Read-only staging checks passed. Physical-device and provider acceptance remain separate.\n')).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
