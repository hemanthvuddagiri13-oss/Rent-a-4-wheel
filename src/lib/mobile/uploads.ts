import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { boundedBody } from "@/lib/bounded-request";
import { validateAndSanitizeDocument, scanForMalware, computeRetentionExpiresAt, MAX_DOCUMENT_SIZE_BYTES } from "@/lib/documents";
import { storePrivateDocument } from "@/lib/storage";
import { lockReservation } from "@/lib/financial-locks";
import { authenticateMobile, MobileError } from "./auth";
import { mobileMutation } from "./mutation";
import { mobileReservationAccess } from "./queries";

export const uploadSchema = z.object({
  reservationId: z.string().max(128).optional(), type: z.enum(["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE", "INSPECTION"]),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(1).max(MAX_DOCUMENT_SIZE_BYTES),
}).strict();
export async function initializeMobileUpload(req: Request, input: unknown) {
  const data = uploadSchema.parse(input);
  if (data.type === "INSPECTION" && !data.reservationId) throw new MobileError("INVALID_REQUEST", 400);
  return mobileMutation(req, "document.initialize", data, async (tx, userId) => { if (data.reservationId) await mobileReservationAccess(tx, userId, data.reservationId, data.type !== "INSPECTION"); }, async (tx, userId) => {
    const row = await tx.mobileUpload.create({ data: { userId, reservationId: data.reservationId, type: data.type, mimeType: data.mimeType, expectedSha256: data.sha256, expectedSize: data.size, expiresAt: new Date(Date.now() + 15 * 60000) } });
    return { id: row.id, expiresAt: row.expiresAt.toISOString(), maxBytes: MAX_DOCUMENT_SIZE_BYTES };
  });
}
export async function finalizeMobileUpload(req: Request, id: string) {
  const actor = await authenticateMobile(req.headers);
  const key = req.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new MobileError("INVALID_REQUEST", 400);
  const upload = await prisma.mobileUpload.findFirst({ where: { id, userId: actor.userId } });
  if (!upload) throw new MobileError("NOT_FOUND", 404);
  if (!upload.finalizedAt && upload.expiresAt <= new Date()) throw new MobileError("CONFLICT", 409);
  if (upload.reservationId) await mobileReservationAccess(prisma, actor.userId, upload.reservationId, upload.type !== "INSPECTION");
  if (req.headers.get("content-type") !== upload.mimeType) throw new MobileError("INVALID_REQUEST", 415);
  const raw = await boundedBody(req, MAX_DOCUMENT_SIZE_BYTES);
  const hash = createHash("sha256").update(raw).digest("hex");
  if (raw.length !== upload.expectedSize || hash !== upload.expectedSha256) throw new MobileError("CONFLICT", 409);
  // Initialization durably froze input evidence before any provider/storage IO.
  // Stable storage identity reuses the storage service's durable write intent;
  // ambiguous writes remain review-blocked there, never assigned a fresh key.
  let stored: { storageKey: string; mimeType: string; sha256: string; size: number } | undefined;
  if (!upload.finalizedAt) {
    const clean = await validateAndSanitizeDocument(raw, upload.mimeType);
    if ((await scanForMalware(clean.buffer)).status !== "CLEAN") throw new MobileError("UNAVAILABLE", 503);
    const object = await storePrivateDocument(clean.buffer, clean.mimeType, upload.id);
    stored = { ...object, mimeType: clean.mimeType, sha256: clean.sha256, size: clean.buffer.length };
  }
  return mobileMutation(req, "document.finalize", { id, sha256: hash }, async (tx, userId) => {
    if (upload.reservationId) { await lockReservation(tx, upload.reservationId); await mobileReservationAccess(tx, userId, upload.reservationId, upload.type !== "INSPECTION"); }
  }, async (tx, userId) => {
    await tx.$queryRaw`SELECT "id" FROM "MobileUpload" WHERE "id"=${id} FOR UPDATE`;
    const current = await tx.mobileUpload.findUniqueOrThrow({ where: { id } });
    if (current.finalizedAt) return { id };
    if (current.expiresAt <= new Date() || !stored) throw new MobileError("CONFLICT", 409);
    if (current.type !== "INSPECTION") {
      const type = z.enum(["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"]).parse(current.type);
      await tx.driverDocument.create({ data: { id, userId, reservationId: current.reservationId, type, storageKey: stored.storageKey, mimeType: stored.mimeType, fileSizeBytes: stored.size, contentSha256: stored.sha256, malwareScanStatus: "CLEAN", status: "PENDING_VERIFICATION", retentionExpiresAt: computeRetentionExpiresAt() } });
    }
    await tx.mobileUpload.update({ where: { id }, data: { finalizedAt: new Date(), storageKey: stored.storageKey } });
    await tx.auditLog.create({ data: { actorId: userId, action: "mobile.document_finalized", entityType: "DriverDocument", entityId: id } });
    return { id };
  });
}
