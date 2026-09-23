import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logDocumentAccess } from "@/lib/documents";
import { readPrivateDocument } from "@/lib/storage";
import { mobileReservationAccess } from "./queries";
import { authenticateMobile, MobileError } from "./auth";
import { mobileIp } from "./http";

function secret() { const key = process.env.AUTH_SECRET; if (!key || key.length < 24) throw new MobileError("UNAVAILABLE", 503); return key; }
async function authorizedDocument(userId: string, id: string) {
  return prisma.$transaction(async tx => {
    const doc = await tx.driverDocument.findUnique({ where: { id } });
    if (!doc || doc.deletedAt || doc.retentionExpiresAt && doc.retentionExpiresAt <= new Date()) throw new MobileError("NOT_FOUND", 404);
    if (doc.userId !== userId) {
      if (!doc.reservationId) throw new MobileError("NOT_FOUND", 404);
      await mobileReservationAccess(tx, userId, doc.reservationId);
    }
    // Native previews deliberately require CLEAN even for the uploader.
    if (doc.malwareScanStatus !== "CLEAN") throw new MobileError("FORBIDDEN", 403);
    return doc;
  });
}
export async function issueDocumentAccess(req: Request, input: unknown) {
  const { documentId } = z.object({ documentId: z.string().min(1).max(128) }).strict().parse(input);
  const actor = await authenticateMobile(req.headers);
  const doc = await authorizedDocument(actor.userId, documentId);
  const payload = Buffer.from(JSON.stringify({ id: doc.id, user: actor.userId, session: actor.sessionId, purpose: "IDENTITY_PREVIEW", expires: Date.now() + 60000 })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  await logDocumentAccess({ documentId, accessedById: actor.userId, purpose: "mobile_preview_issued", ipAddress: mobileIp(req.headers) });
  return { capability: payload + "." + signature, expiresInSeconds: 60, documentId };
}
export async function readMobileDocument(req: Request, id: string) {
  const actor = await authenticateMobile(req.headers), value = req.headers.get("x-file-access") ?? "";
  if (value.length > 1024) throw new MobileError("FORBIDDEN", 403);
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new MobileError("FORBIDDEN", 403);
  const actual = Buffer.from(signature), expected = Buffer.from(createHmac("sha256", secret()).update(payload).digest("base64url"));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new MobileError("FORBIDDEN", 403);
  let claim: { id: string; user: string; session: string; purpose: string; expires: number };
  try { claim = z.object({ id: z.string(), user: z.string(), session: z.string(), purpose: z.literal("IDENTITY_PREVIEW"), expires: z.number().int() }).strict().parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); }
  catch { throw new MobileError("FORBIDDEN", 403); }
  if (claim.id !== id || claim.user !== actor.userId || claim.session !== actor.sessionId || claim.expires <= Date.now() || claim.expires > Date.now() + 60000) throw new MobileError("FORBIDDEN", 403);
  const doc = await authorizedDocument(actor.userId, id);
  await logDocumentAccess({ documentId: id, accessedById: actor.userId, purpose: "mobile_identity_preview", ipAddress: mobileIp(req.headers) });
  const { buffer } = await readPrivateDocument(doc.storageKey);
  // Storage IO may outlive membership/session revocation or quarantine. Recheck
  // before returning bytes, including the exact object originally authorized.
  await authenticateMobile(req.headers);
  const current = await authorizedDocument(actor.userId, id);
  if (current.storageKey !== doc.storageKey || current.mimeType !== doc.mimeType) throw new MobileError("NOT_FOUND", 404);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": doc.mimeType, "Content-Disposition": 'inline; filename="private-document"', "Cache-Control": "private, no-store" } });
}
