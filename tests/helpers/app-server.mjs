import next from 'next';
import { createServer } from 'node:http';
const port=Number(process.env.BROWSER_TEST_PORT || 3199);
const app=next({dev:true,hostname:'127.0.0.1',port});
await app.prepare();
const server=createServer(app.getRequestHandler());
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
