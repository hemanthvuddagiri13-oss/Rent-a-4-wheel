import { createConnection } from "node:net";
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
    const socket = createConnection({ host, port });
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
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < buffer.length; offset += 65536) {
        const chunk = buffer.subarray(offset, offset + 65536), size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length); socket.write(size); socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
