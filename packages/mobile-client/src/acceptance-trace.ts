import { operationMetadata } from './generated';
// Synthetic loopback acceptance builds only. Never accept payloads, route params,
// labels, user IDs, idempotency keys or arbitrary error strings as trace fields.
const controls = new Set(['home-sign-in', 'email-fallback', 'case-refresh', 'recover-replyCase', 'recover-sendMessage', 'recover-tripReturn', 'recover-tripCancel']);
const screens = new Set(['Home', 'SignIn', 'EmailSignIn', 'Case', 'Recovery']);
const phases = new Set(['ready', 'disabled', 'touch', 'press-in', 'press-out', 'press', 'navigation', 'mount', 'unmount', 'action', 'refresh', 'loading', 'loaded', 'error', 'request', 'response', 'transport-error']);
export function createAcceptanceTrace(enabled: boolean, deliver: typeof fetch) {
let sequence = 0;
function trace(phase: string, target: string | undefined, requestId?: string, status?: number) {
  if (!enabled || !target || !phases.has(phase) || !(controls.has(target) || screens.has(target) || Object.hasOwn(operationMetadata, target))) return;
  const row = { event: 'native.ui', phase, target, sequence: ++sequence, timestamp: new Date().toISOString(), ...(requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? { requestId } : {}), ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}) };
  // No credentials, persistence, retries or awaited work in the interaction path.
  void deliver('http://localhost:3000/__native-ui-trace', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) }).catch(() => {});
}
function traceOperation(input: Parameters<typeof fetch>[0], method?: string) {
  if (!enabled) return undefined;
  try {
    const url = new URL(String(input));
    if (url.origin !== 'http://localhost:3000') return undefined;
    return Object.entries(operationMetadata).find(([, op]) => op.method === (method ?? 'GET') && new RegExp('^/api/v1/mobile' + op.path.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(url.pathname))?.[0];
  } catch { return undefined; }
}

return { trace, traceOperation };
}
