// Disposable CI proxy diagnostics. Never export paths, query strings or headers.
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const stages = new Set(['ingress-entry', 'upstream-dispatch', 'upstream-headers', 'upstream-end', 'response-finish', 'response-close', 'response-disconnected', 'upstream-error']);
export function browserOperation(method, url) {
  if (method !== 'GET' || typeof url !== 'string') return null;
  const path = url.split('?')[0];
  if (/^\/account\/reservations\/[A-Za-z0-9_-]{1,128}$/.test(path)) return 'browserReservation';
  if (path === '/sign-in') return 'browserSignIn';
  return null;
}
export function browserTiming(row) {
  if (!['browserReservation', 'browserSignIn'].includes(row.operation) || !stages.has(row.stage) || !uuid.test(row.correlationId ?? '') || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.timestamp ?? '')) return null;
  return { event: 'native.browser', operation: row.operation, stage: row.stage, correlationId: row.correlationId, timestamp: row.timestamp,
    ...(uuid.test(row.requestId ?? '') ? { requestId: row.requestId } : {}),
    ...(Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? { status: row.status } : {}) };
}
export function browserCompileTiming(line) {
  // Next development-server timing only; discard the entire URL and log line.
  const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^\s*GET (\/sign-in|\/account\/reservations\/[A-Za-z0-9_-]{1,128})(?:\?\S*)? ([1-5]\d{2}) in ([\d.]+)(ms|s) \(compile: ([\d.]+)(ms|s),/);
  if (!match) return null;
  const durationMs = Number(match[3]) * (match[4] === 's' ? 1000 : 1), compileMs = Number(match[5]) * (match[6] === 's' ? 1000 : 1);
  if (!Number.isFinite(durationMs) || !Number.isFinite(compileMs)) return null;
  return { event: 'native.browser.compile', operation: match[1] === '/sign-in' ? 'browserSignIn' : 'browserReservation', status: Number(match[2]), durationMs, compileMs };
}
