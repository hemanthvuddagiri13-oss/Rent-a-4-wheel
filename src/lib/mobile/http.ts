import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z, ZodError } from "zod";
import { boundedBody } from "@/lib/bounded-request";
import { sharedRequestLimit } from "@/lib/security-request";
import { MarketplaceError } from "@/lib/marketplace";
import { MobileError } from "./auth";

export const MOBILE_VERSION = "1";
export function mobileIp(headers: Headers) {
  // Ingress must strip/replace x-real-ip. Never accept a forwarding chain.
  const raw = headers.get("x-real-ip") ?? "";
  return createHmac("sha256", process.env.AUTH_SECRET ?? "local-only").update(isIP(raw) ? raw : "unknown").digest("hex");
}
export async function mobileBody(req: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) throw new MobileError("INVALID_REQUEST", 415);
  try { return JSON.parse((await boundedBody(req, 24_000)).toString("utf8")) as unknown; }
  catch (error) { if (error instanceof MarketplaceError) throw error; throw new MobileError("INVALID_REQUEST", 400); }
}
export const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(128).optional() });
export function pageInput(req: Request) { return pageSchema.parse(Object.fromEntries(new URL(req.url).searchParams)); }
export function mobileResponse(data: unknown, requestId: string, status = 200) {
  return Response.json({ data, error: null, requestId }, { status, headers: mobileHeaders(requestId) });
}
export function mobileHeaders(requestId: string) {
  return { "X-API-Version": MOBILE_VERSION, "X-Request-ID": requestId, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Vary": "Authorization", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
}
export async function mobileHandler(req: Request, operation: string, run: (requestId: string) => Promise<unknown>) {
  const requestId = randomUUID(), start = performance.now(); let status = 200;
  try {
    const requested = req.headers.get("x-api-version");
    if (requested && requested !== MOBILE_VERSION) throw new MobileError("INVALID_REQUEST", 400);
    if (!await sharedRequestLimit(req.headers, operation.startsWith("auth.") ? "mobile-auth" : "mobile-api", operation.startsWith("auth.") ? 30 : 120)) throw new MobileError("RATE_LIMITED", 429);
    const data = await run(requestId);
    if (data instanceof Response) { status = data.status; for (const [key, value] of Object.entries(mobileHeaders(requestId))) data.headers.set(key, value); return data; }
    return mobileResponse(data, requestId);
  } catch (error) {
    status = error instanceof MobileError || error instanceof MarketplaceError ? error.status : error instanceof ZodError ? 400 : 500;
    const code = error instanceof MobileError ? error.code : status === 400 || status === 413 ? "INVALID_REQUEST" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 429 ? "RATE_LIMITED" : "UNAVAILABLE";
    return Response.json({ data: null, error: { code }, requestId }, { status, headers: { ...mobileHeaders(requestId), ...(status === 429 ? { "Retry-After": "60" } : {}) } });
  } finally {
    // Callers supply a fixed operation label, never a URL, ID or request data.
    console.info(JSON.stringify({ event: "mobile.request", operation, requestId, status, durationMs: Math.round(performance.now() - start) }));
  }
}
