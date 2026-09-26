import { randomUUID } from 'node:crypto';
// CI-only reverse proxy: real Next routes/PostgreSQL execute first; one committed
// support reply and upload response bodies are truncated to exercise app recovery.
import { createServer as httpServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
if (process.env.CI !== 'true' || process.env.APP_ENV !== 'test' || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Disposable CI only');
const dropped = new Set();
httpServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__native-ui-trace') {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try { const row = JSON.parse(body);
        const phases = ['ready', 'disabled', 'touch', 'press-in', 'press-out', 'press', 'navigation', 'mount', 'unmount', 'action', 'refresh', 'loading', 'loaded', 'error', 'request', 'response', 'transport-error'];
        // Strict fixed vocabulary: even a malicious loopback request cannot put
        // private text into the exported trace through this diagnostic endpoint.
        const targets = ['home-sign-in', 'email-fallback', 'case-refresh', 'recover-replyCase', 'recover-sendMessage', 'recover-tripReturn', 'recover-tripCancel', 'Home', 'SignIn', 'EmailSignIn', 'Case', 'Recovery', 'vehicles', 'me', 'serviceCase', 'caseEvents', 'replyCase', 'openCase', 'resolveMutation'];
        if (row.event !== 'native.ui' || !phases.includes(row.phase) || !targets.includes(row.target) || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.timestamp)) throw new Error('Invalid trace');
        console.log(JSON.stringify({ event: 'native.ui', phase: row.phase, target: row.target, sequence: row.sequence, timestamp: row.timestamp, receivedAt: new Date().toISOString(), ...(/^[0-9a-f-]{36}$/i.test(row.requestId ?? '') ? { requestId: row.requestId } : {}), ...(Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? { status: row.status } : {}) }));
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    }); return;
  }
  const fault = existsSync('/tmp/host-incident-fault') ? readFileSync('/tmp/host-incident-fault', 'utf8').trim() : '';
  if (fault === 'submission' && req.method === 'POST' && req.url === '/api/v1/mobile/cases' || fault === 'readback' && req.method === 'GET' && /^\/api\/v1\/mobile\/cases\/[^/]+(?:\/events)?$/.test(req.url.split('?')[0])) {
    const requestId = randomUUID(); req.resume(); console.log(JSON.stringify({ event: 'synthetic.incident_rejected', kind: fault, timestamp: new Date().toISOString(), requestId }));
    res.writeHead(503, { 'x-request-id': requestId, 'x-api-version': '1', 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ requestId, error: { code: 'UNAVAILABLE', message: 'Synthetic incident acceptance failure.' } })); return;
  }
  const upstream = request({ hostname: '127.0.0.1', port: 3001, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:3001' } }, response => {
    const kind = req.method === 'POST' && /\/cases\/[^/]+\/reply$/.test(req.url) ? 'reply' : req.method === 'POST' && /\/uploads\/[^/]+\/finalize$/.test(req.url) ? 'upload' : req.method === 'POST' && /\/conversations\/[^/]+\/messages$/.test(req.url) ? 'message' : req.method === 'POST' && /\/reservations\/[^/]+\/return$/.test(req.url) ? 'return' : req.method === 'POST' && /\/reservations\/[^/]+\/cancel$/.test(req.url) ? 'cancel' : null;
    if (kind && (process.env.CUSTOMER_RECOVERY !== 'true' || kind === 'message' || kind === 'cancel' || kind === 'upload') && response.statusCode === 200 && !dropped.has(kind)) {
      dropped.add(kind); response.resume(); response.on('end', () => {
        // Closing before headers lets native networking transparently resend the
        // request. Deliver an incomplete JSON envelope after consuming the real
        // committed response instead: parsing must fail on both platforms and
        // the app retains the original intent until an explicit user retry.
        console.log(JSON.stringify({ event: 'synthetic.response_truncated_after_commit', kind, timestamp: new Date().toISOString(), requestId: response.headers['x-request-id'] }));
        res.writeHead(200, { 'x-request-id': response.headers['x-request-id'], 'content-type': 'application/json', 'x-api-version': '1', 'cache-control': 'no-store', 'content-length': '1' });
        res.end('{');
      }); return;
    }
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
}).listen(3000, '127.0.0.1');
// Explicit protocol fixture, NOT real malware scanning evidence. Only installed
// synthetic acceptance builds use this private loopback daemon. Production code
// still requires exact scanner success and fails closed on errors.
tcpServer(socket => {
  let bytes = Buffer.alloc(0), header = false;
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (!header) { if (bytes.length < 10) return; if (bytes.subarray(0, 10).toString() !== 'zINSTREAM\0') return socket.destroy(); bytes = bytes.subarray(10); header = true; }
    while (bytes.length >= 4) { const length = bytes.readUInt32BE(); if (length > 8388608) return socket.destroy(); if (bytes.length < length + 4) return; bytes = bytes.subarray(length + 4); if (length === 0) { socket.end('stream: OK\0'); return; } }
  });
}).listen(3310, '127.0.0.1');
