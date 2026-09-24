// Whitelist operational telemetry only. Never upload raw API request logs,
// uploaded bytes, auth headers, capabilities or database contents.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('artifacts', { recursive: true });
const rows = [];
for (const path of ['/tmp/native-api.log', '/tmp/native-proxy.log']) {
  let text; try { text = readFileSync(path, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const start = line.indexOf('{'); if (start < 0) continue;
    try { const row = JSON.parse(line.slice(start));
      if (row.event === 'mobile.request') rows.push({ event: row.event, timestamp: row.timestamp, operation: row.operation, requestId: row.requestId, status: row.status, durationMs: row.durationMs, ...(['RESPONSE_CONTRACT', 'DATABASE_TRANSACTION', 'DATABASE_POOL', 'DATABASE_CONFLICT', 'DATABASE_OPERATION', 'RELEASE_GATE', 'INTERNAL'].includes(row.failureKind) ? { failureKind: row.failureKind } : {}) });
      if (['synthetic.response_truncated_after_commit', 'synthetic.incident_rejected'].includes(row.event)) rows.push({ event: row.event, kind: row.kind });
    } catch { /* Other backend output is not an artifact. */ }
  }
}
writeFileSync('artifacts/native-api-telemetry.json', JSON.stringify(rows, null, 2));
