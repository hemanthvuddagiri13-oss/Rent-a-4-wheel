import { deviceTrialProblems } from './native-device-trial-gate.mjs';
import { pathToFileURL } from 'node:url';

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Staging response has no body');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 262144) throw new Error('Staging response exceeds limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

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
    ['/api/v1/mobile/vehicles', body => body?.error === null && Array.isArray(body?.data?.items) && (body.data.nextCursor === null || typeof body.data.nextCursor === 'string') && /^[0-9a-f-]{36}$/i.test(body?.requestId ?? '')],
  ]) {
    const response = await request(origin + path, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
    if (response.status !== 200 || response.url !== origin + path) { await response.body?.cancel(); throw new Error(`Staging check failed: ${path} returned an unexpected status or origin`); }
    const type = response.headers.get('content-type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(type)) { await response.body?.cancel(); throw new Error(`Staging check failed: ${path} did not return JSON`); }
    let body;
    try { body = await boundedJson(response); } catch { throw new Error(`Staging check failed: ${path} returned invalid or oversized JSON`); }
    if (!valid(body)) throw new Error(`Staging check failed: ${path} returned an unhealthy response`);
    if (path.startsWith('/api/v1/') && (response.headers.get('x-api-version') !== '1' || response.headers.get('x-request-id') !== body.requestId)) throw new Error('Staging mobile response contract headers do not match');
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeNativeStaging(process.env).then(() => process.stdout.write('Read-only staging checks passed. Physical-device and provider acceptance remain separate.\n')).catch(error => {
    // Fetch errors can contain infrastructure details; never print raw errors.
    void error; process.stderr.write('Read-only staging check failed. No readiness certification issued.\n');
    process.exitCode = 1;
  });
}
