import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { localDevelopment } from "@/lib/deployment-environment";
export function authenticatedCron(headers: Headers): boolean {
  const key = process.env.CRON_SECRET; if (!key) return false;
  const actual = Buffer.from(headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function requestOriginAllowed(req: Request): boolean {
  const expected = process.env.SITE_URL ?? process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const origin = req.headers.get("origin");
  if (!origin) return localDevelopment();
  try { return origin === new URL(expected ?? (localDevelopment() ? req.url : "")).origin && req.headers.get("sec-fetch-site") !== "cross-site"; } catch { return false; }
}
export function newRequestId() { return randomUUID(); }
export async function sharedRequestLimit(headers: Headers, scope: string, max = 120) {
  // The deployment ingress MUST replace this header; client forwarding chains are never parsed.
  const source = headers.get("x-real-ip") ?? "unknown";
  const digest = createHmac("sha256", process.env.AUTH_SECRET ?? "local-only").update(source.slice(0,128)).digest("hex");
  const key = `request:${scope}:${digest}`;
  const rows = await prisma.$queryRaw<Array<{count:number}>>`INSERT INTO "MarketplaceRateLimit" (key,"windowStart",count) VALUES (${key},CURRENT_TIMESTAMP,1)
    ON CONFLICT (key) DO UPDATE SET count=CASE WHEN "MarketplaceRateLimit"."windowStart" < CURRENT_TIMESTAMP-interval '1 minute' THEN 1 ELSE "MarketplaceRateLimit".count+1 END,
    "windowStart"=CASE WHEN "MarketplaceRateLimit"."windowStart" < CURRENT_TIMESTAMP-interval '1 minute' THEN CURRENT_TIMESTAMP ELSE "MarketplaceRateLimit"."windowStart" END RETURNING count`;
  return rows[0].count <= max;
}
