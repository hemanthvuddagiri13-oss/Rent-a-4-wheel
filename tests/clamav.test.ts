import { createServer, type Server } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { scanWithClamAv } from "@/lib/clamav";
let server: Server | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });
async function daemon(response: string) {
  const received: Buffer[] = [];
  server = createServer(socket => {
    let data = Buffer.alloc(0), framed = false, remaining = -1;
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (!framed) { const end = data.indexOf(0); if (end < 0) return; expect(data.subarray(0, end).toString()).toBe("zINSTREAM"); data = data.subarray(end + 1); framed = true; }
      while (data.length >= 4 || remaining >= 0) {
        if (remaining < 0) { remaining = data.readUInt32BE(0); data = data.subarray(4); }
        if (remaining === 0) { socket.end(response); return; }
        if (data.length < remaining) return;
        received.push(data.subarray(0, remaining)); data = data.subarray(remaining); remaining = -1;
      }
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("CLAMAV_HOST", "127.0.0.1"); vi.stubEnv("CLAMAV_PORT", String((server.address() as { port: number }).port));
  return received;
}
it("sends the complete file using real INSTREAM framing and accepts only terminated OK", async () => {
  const bytes = Buffer.alloc(180000, 42), received = await daemon("stream: OK\0");
  expect(await scanWithClamAv(bytes)).toEqual({ status: "CLEAN" }); expect(Buffer.concat(received)).toEqual(bytes);
});
it.each(["stream: OK", "stream: size limit exceeded ERROR\0", "OK\0", "stream: OK\0unexpected"])("fails closed for %s", async response => {
  await daemon(response); expect(await scanWithClamAv(Buffer.from("synthetic"))).toEqual({ status: "SCAN_UNAVAILABLE" });
});
it("preserves an infected verdict", async () => { await daemon("stream: Synthetic-Test-Signature FOUND\0"); expect(await scanWithClamAv(Buffer.from("synthetic"))).toEqual({ status: "INFECTED" }); });
it("fails closed without configuration", async () => { vi.stubEnv("CLAMAV_HOST", ""); expect(await scanWithClamAv(Buffer.from("synthetic"))).toEqual({ status: "SCAN_UNAVAILABLE" }); });
