// Whitelist operational telemetry only. Never upload raw API request logs,
// uploaded bytes, auth headers, capabilities or database contents.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { browserTiming, browserCompileTiming } from './native-browser-timing.mjs';
mkdirSync('artifacts', { recursive: true });
const rows = [];
for (const path of ['/tmp/native-api.log', '/tmp/native-proxy.log']) {
  let text; try { text = readFileSync(path, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const compile = browserCompileTiming(line); if (compile) rows.push(compile);
    const start = line.indexOf('{'); if (start < 0) continue;
    try { const row = JSON.parse(line.slice(start));
      if (row.event === 'native.browser') { const safe = browserTiming(row); if (safe) rows.push(safe); }
      if (row.event === 'native.timing' && row.operation === 'requestCode' && ['ingress-entry', 'upstream-dispatch', 'upstream-headers', 'upstream-end', 'response-finish', 'response-close', 'response-disconnected', 'proxy-entry', 'proxy-forward', 'route-entry', 'handler-entry', 'limit-complete', 'body-complete', 'user-complete', 'hash-start', 'hash-complete', 'transaction-entry', 'locks-acquired', 'transaction-complete', 'delivery-complete', 'audit-complete', 'handler-complete'].includes(row.stage) && /^[0-9a-f-]{36}$/i.test(row.correlationId ?? '')) rows.push({ event: row.event, operation: row.operation, stage: row.stage, correlationId: row.correlationId, timestamp: row.timestamp, ...(/^[0-9a-f-]{36}$/i.test(row.requestId ?? '') ? { requestId: row.requestId } : {}) });
      if (row.event === 'native.ui') rows.push({ event: row.event, phase: row.phase, target: row.target, sequence: row.sequence, timestamp: row.timestamp, receivedAt: row.receivedAt, requestId: row.requestId, status: row.status });
      if (row.event === 'mobile.request') rows.push({ event: row.event, timestamp: row.timestamp, operation: row.operation, requestId: row.requestId, status: row.status, durationMs: row.durationMs, ...(['RESPONSE_CONTRACT', 'DATABASE_TRANSACTION', 'DATABASE_POOL', 'DATABASE_CONFLICT', 'DATABASE_OPERATION', 'RELEASE_GATE', 'INTERNAL'].includes(row.failureKind) ? { failureKind: row.failureKind } : {}) });
      if (['synthetic.response_truncated_after_commit', 'synthetic.incident_rejected', 'synthetic.read_interrupted'].includes(row.event)) rows.push({ event: row.event, kind: row.kind, timestamp: row.timestamp, requestId: row.requestId });
    } catch { /* Other backend output is not an artifact. */ }
  }
}
writeFileSync('artifacts/native-api-telemetry.json', JSON.stringify(rows, null, 2));
