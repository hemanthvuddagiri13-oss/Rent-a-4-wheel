import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z, ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { boundedBody } from "@/lib/bounded-request";
import { sharedRequestLimit } from "@/lib/security-request";
import { MarketplaceError } from "@/lib/marketplace";
import { HoldError } from "@/lib/checkout-hold";
import { JurisdictionUnavailable } from "@/lib/jurisdiction";
import { ReleaseGateError } from "@/lib/release-control";
import { InvalidDocumentError } from "@/lib/documents";
import { MobileError } from "./auth";
import { mobileOperation } from "./contract";

export const MOBILE_VERSION = "1";
export function mobileIp(headers: Headers) {
  // Ingress must strip/replace x-real-ip. Never accept a forwarding chain.
  const raw = headers.get("x-real-ip") ?? "";
  return createHmac("sha256", process.env.AUTH_SECRET ?? "local-only").update(isIP(raw) ? raw : "unknown").digest("hex");
}
export async function mobileBody(req: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) throw new MobileError("INVALID_REQUEST", 415);
  try { const data: unknown = JSON.parse((await boundedBody(req, 24_000)).toString("utf8")); return mobileOperation(req)?.body?.parse(data) ?? data; }
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
  const requestId = randomUUID(), start = performance.now(); let status = 200, telemetryOperation = operation, failureKind: string | undefined;
  try {
    const requested = req.headers.get("x-api-version");
    if (requested && requested !== MOBILE_VERSION) throw new MobileError("INVALID_REQUEST", 400);
    const contract = mobileOperation(req);
    if (!contract) throw new MobileError("NOT_FOUND", 404);
    telemetryOperation = contract.operationId;
    if (!await sharedRequestLimit(req.headers, operation.startsWith("auth.") ? "mobile-auth" : "mobile-api", operation.startsWith("auth.") ? 30 : 120)) throw new MobileError("RATE_LIMITED", 429);
    const data = await run(requestId);
    if (data instanceof Response) { status = data.status; for (const [key, value] of Object.entries(mobileHeaders(requestId))) data.headers.set(key, value); return data; }
    // Validate serialized DTOs against the same schemas used to generate the
    // contract. Strict response objects fail closed on accidental extra fields.
    const result = contract.response.safeParse(JSON.parse(JSON.stringify(data)));
    if (!result.success) { failureKind = "RESPONSE_CONTRACT"; throw new MobileError("UNAVAILABLE", 500); }
    return mobileResponse(result.data, requestId);
  } catch (error) {
    status = error instanceof MobileError || error instanceof MarketplaceError || error instanceof HoldError ? error.status : error instanceof ZodError || error instanceof InvalidDocumentError ? 400 : error instanceof JurisdictionUnavailable ? 409 : error instanceof ReleaseGateError ? 503 : 500;
    // Fixed categories only: Prisma messages/meta may contain query arguments,
    // identity data or credentials. Never log the exception itself.
    if (status >= 500 && !failureKind) failureKind = error instanceof Prisma.PrismaClientKnownRequestError
      ? (({ P2028: "DATABASE_TRANSACTION", P2024: "DATABASE_POOL", P2034: "DATABASE_CONFLICT" } as Record<string, string>)[error.code] ?? "DATABASE_OPERATION")
      : error instanceof ReleaseGateError ? "RELEASE_GATE" : "INTERNAL";
    const code = error instanceof MobileError ? error.code : status === 400 || status === 413 ? "INVALID_REQUEST" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 429 ? "RATE_LIMITED" : "UNAVAILABLE";
    return Response.json({ data: null, error: { code }, requestId }, { status, headers: { ...mobileHeaders(requestId), ...(status === 429 ? { "Retry-After": "60" } : {}) } });
  } finally {
    // Callers supply a fixed operation label, never a URL, ID or request data.
    console.info(JSON.stringify({ event: "mobile.request", timestamp: new Date().toISOString(), operation: telemetryOperation, requestId, status, durationMs: Math.round(performance.now() - start), ...(failureKind ? { failureKind } : {}) }));
  }
}
