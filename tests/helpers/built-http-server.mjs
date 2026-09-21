import next from "next";
import {createServer} from "node:http";
// Uses the production artifact (dev:false). Local trust settings permit only
// loopback synthetic providers; separate staging journeys exercise TLS/config.
const port=Number(process.env.BUILT_HTTP_TEST_PORT),app=next({dev:false,hostname:"127.0.0.1",port});
await app.prepare();
const server=createServer(app.getRequestHandler());server.listen(port,"127.0.0.1");
process.on("SIGTERM",async()=>{await app.close();server.close(()=>process.exit(0));server.closeAllConnections();});
