// Timing only, for disposable loopback installed-app CI. Never log inputs.
const stages = new Set(['proxy-entry', 'proxy-forward', 'route-entry', 'handler-entry', 'limit-complete', 'body-complete', 'user-complete', 'hash-start', 'hash-complete', 'transaction-entry', 'locks-acquired', 'transaction-complete', 'delivery-complete', 'audit-complete', 'handler-complete']);
export function acceptanceTiming(req: Request) {
  let enabled = false;
  try { enabled = process.env.CI === 'true' && process.env.APP_ENV === 'test' && process.env.NATIVE_ACCEPTANCE === '1' && new URL(process.env.DATABASE_URL ?? '').pathname.endsWith('_test') && ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname) && new URL(req.url).pathname === '/api/v1/mobile/auth/request-code' && req.method === 'POST'; } catch { /* Disabled outside disposable CI. */ }
  const correlationId = req.headers.get('x-native-timing-id') ?? '';
  const valid = enabled && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(correlationId);
  return (stage: string, requestId?: string) => {
    if (!valid || !stages.has(stage)) return;
    try { console.info(JSON.stringify({ event: 'native.timing', operation: 'requestCode', stage, correlationId, timestamp: new Date().toISOString(), ...(requestId && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId) ? { requestId } : {}) })); } catch { /* Diagnostics never change issuance. */ }
  };
}
