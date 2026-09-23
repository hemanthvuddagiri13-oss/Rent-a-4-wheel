// CI-only reverse proxy: real Next routes/PostgreSQL execute first; one committed
// support reply and upload response are discarded to exercise app recovery.
import { createServer as httpServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
if (process.env.CI !== 'true' || process.env.APP_ENV !== 'test' || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Disposable CI only');
const dropped = new Set();
httpServer((req, res) => {
  const upstream = request({ hostname: '127.0.0.1', port: 3001, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:3001' } }, response => {
    const kind = req.method === 'POST' && /\/cases\/[^/]+\/reply$/.test(req.url) ? 'reply' : req.method === 'POST' && /\/uploads\/[^/]+\/finalize$/.test(req.url) ? 'upload' : null;
    if (kind && response.statusCode === 200 && !dropped.has(kind)) {
      dropped.add(kind); response.resume(); response.on('end', () => { console.log(JSON.stringify({ event: 'synthetic.response_dropped_after_commit', kind })); res.destroy(); }); return;
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
