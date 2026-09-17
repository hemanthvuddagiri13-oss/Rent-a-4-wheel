import { MarketplaceError } from "@/lib/marketplace";

export async function boundedBody(req: Request, limit: number) {
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw new MarketplaceError("Request is too large.", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new MarketplaceError("Request body required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new MarketplaceError("Request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
