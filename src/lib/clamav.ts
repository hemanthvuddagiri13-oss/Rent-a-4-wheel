import { createConnection } from "node:net";
import {connect as connectTls} from "node:tls";
import {localDevelopment} from "@/lib/deployment-environment";
function scannerConnection(host:string,port:number){
 if(process.env.CLAMAV_TLS==="true")return {socket:connectTls({host,port,servername:host,rejectUnauthorized:true,...(process.env.CLAMAV_CA_CERT?{ca:process.env.CLAMAV_CA_CERT}:{})}),connected:"secureConnect"};
 if(!localDevelopment())throw new Error("SCANNER_TLS_REQUIRED");
 return {socket:createConnection({host,port}),connected:"connect"};
}
export async function scannerVersion():Promise<string>{
 const host=process.env.CLAMAV_HOST,port=Number(process.env.CLAMAV_PORT||3310);if(!host||!Number.isInteger(port)||port<1||port>65535)throw new Error("SCANNER_UNAVAILABLE");
 return new Promise((resolve,reject)=>{let done=false,reply="";const {socket,connected}=scannerConnection(host,port);const finish=(version?:string)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(version)resolve(version);else reject(new Error("SCANNER_UNAVAILABLE"));};const timer=setTimeout(()=>finish(),5000);socket.on(connected,()=>socket.write("zVERSION\0"));socket.on("error",()=>finish());socket.on("end",()=>finish());socket.on("data",chunk=>{reply+=chunk.toString("utf8");if(reply.length>1024)return finish();if(!reply.includes("\0"))return;const match=/^ClamAV ([0-9.]+)\/([0-9]+)\//.exec(reply);finish(match?match[1]+"/"+match[2]:undefined);});});
}
export type ScanResult = { status: "CLEAN" | "INFECTED" | "SCAN_UNAVAILABLE" };

/** ClamAV INSTREAM: https://docs.clamav.net/manual/Usage/ClamdProtocol.html
 * Only an exact, terminated OK reply permits release. Never accept EOF,
 * timeouts, size errors, partial replies or arbitrary success-like strings.
 * Configure a private trusted daemon; this protocol does not authenticate TCP.
 */
export async function scanWithClamAv(buffer: Buffer): Promise<ScanResult> {
  const host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT || 3310);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !buffer.length || buffer.length > 8 * 1024 * 1024) return { status: "SCAN_UNAVAILABLE" };
  return new Promise(resolve => {
    let settled = false, reply = Buffer.alloc(0);
    let connection:ReturnType<typeof scannerConnection>;
    try{connection=scannerConnection(host,port);}catch{resolve({status:"SCAN_UNAVAILABLE"});return;}
    const {socket,connected}=connection;
    const deadline = setTimeout(() => finish("SCAN_UNAVAILABLE"), 10000);
    function finish(status: ScanResult["status"]) { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); resolve({ status }); }
    socket.on("error", () => finish("SCAN_UNAVAILABLE"));
    socket.on("end", () => finish("SCAN_UNAVAILABLE"));
    socket.on("close", () => finish("SCAN_UNAVAILABLE"));
    socket.on("data", chunk => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > 4096) return finish("SCAN_UNAVAILABLE");
      const end = reply.indexOf(0);
      if (end < 0) return;
      const message = reply.subarray(0, end).toString("utf8");
      if (end !== reply.length - 1) return finish("SCAN_UNAVAILABLE");
      finish(message === "stream: OK" ? "CLEAN" : /^stream: .+ FOUND$/.test(message) ? "INFECTED" : "SCAN_UNAVAILABLE");
    });
    socket.on(connected, () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < buffer.length; offset += 65536) {
        const chunk = buffer.subarray(offset, offset + 65536), size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length); socket.write(size); socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
