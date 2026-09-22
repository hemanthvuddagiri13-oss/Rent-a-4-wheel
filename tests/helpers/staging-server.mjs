import next from "next";
import {createServer} from "node:https";
import {readFileSync} from "node:fs";
// The real production build and PostgreSQL sit behind this controlled TLS ingress.
const port=Number(process.env.STAGING_TEST_PORT),app=next({dev:false,hostname:"localhost",port});
await app.prepare();
const handler=app.getRequestHandler();
const server=createServer({cert:readFileSync(process.env.CI_TLS_CERT),key:readFileSync(process.env.CI_TLS_KEY)},(req,res)=>{
 req.headers["x-real-ip"]="127.0.0.1";req.headers["x-forwarded-proto"]="https";req.headers["x-forwarded-host"]=`localhost:${port}`;
 return handler(req,res);
});
server.listen(port,"127.0.0.1");
process.on("SIGTERM",async()=>{await app.close();server.close(()=>process.exit(0));server.closeAllConnections();});
