import { prisma } from "@/lib/prisma";
import { MAX_DOCUMENT_SIZE_BYTES, validateAndSanitizeDocument, scanForMalware } from "@/lib/documents";
import { storePrivateDocument, readPrivateDocument, planPrivateDocument } from "@/lib/storage";
import { randomUUID } from "node:crypto";
import { conversationAccess } from "@/lib/conversations";
import { caseAccess } from "@/lib/service-cases";
import { afterDays, audit, policy } from "@/lib/collaboration-access";
import { MarketplaceError } from "@/lib/marketplace";
import type { Prisma } from "@prisma/client";

async function scopeAccess(tx: Prisma.TransactionClient, userId: string, scope: { conversationId?: string | null; caseId?: string | null }, writing = false) {
  if (Boolean(scope.conversationId) === Boolean(scope.caseId)) throw new MarketplaceError("Choose exactly one conversation or case.");
  if (scope.conversationId) {
    if (writing) await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id=${scope.conversationId} FOR UPDATE`;
    const { conversation: c } = await conversationAccess(tx, userId, scope.conversationId);
    if (writing && (!c.reservationId || c.closedAt) && c.retainUntil < new Date()) throw new MarketplaceError("This conversation is archived.", 409);
  }
  if (scope.caseId) {
    if (writing) await tx.$queryRaw`SELECT id FROM "ServiceCase" WHERE id=${scope.caseId} FOR UPDATE`;
    const { c } = await caseAccess(tx, userId, scope.caseId);
    if (writing && ["CLOSED", "RESOLVED", "DECIDED"].includes(c.state)) throw new MarketplaceError("Use the authorized appeal workflow before adding evidence.", 409);
  }
}
export async function uploadCollaborationFile(userId: string, scope: { conversationId?: string; caseId?: string }, file: File, purpose: string) {
  await scopeAccess(prisma, userId, scope, true);
  if (!["MESSAGE", "DAMAGE", "ESTIMATE", "INVOICE", "POLICE_REPORT", "SUPPORT"].includes(purpose)) throw new MarketplaceError("Choose a supported attachment purpose.");
  if (file.size > MAX_DOCUMENT_SIZE_BYTES) throw new MarketplaceError("Choose an image no larger than 8 MB.",413);
  const clean = await validateAndSanitizeDocument(Buffer.from(await file.arrayBuffer()), file.type);
  if ((await scanForMalware(clean.buffer)).status !== "CLEAN") throw new MarketplaceError("The security scan did not approve this file. Try again later.", 422);
  // Scanning is outside the transaction; repeat current authorization afterwards.
  // No driver-document IDs/storage keys are accepted in this API.
  const stableId = randomUUID(), planned = planPrivateDocument(clean.mimeType, stableId);
  const saved = await prisma.$transaction(async tx => {
    await scopeAccess(tx, userId, scope, true);
    const p = await policy(tx);
    const saved = await tx.collaborationFile.create({ data: { ...scope, uploadedById: userId, purpose, storageKey: planned.storageKey, mimeType: clean.mimeType, sha256: clean.sha256, size: clean.buffer.length, scanStatus: "STORING", retainUntil: afterDays(p.attachmentDays) } });
    await audit(tx, userId, "collaboration.file.upload", "CollaborationFile", saved.id);
    return saved;
  }, { timeout: 15000 });
  // Intent and exact private key survive a crash or uncertain storage response.
  // STORING is never readable; no orphan can become an untracked public upload.
  try {
    const stored = await storePrivateDocument(clean.buffer, clean.mimeType, stableId);
    if (stored.storageKey !== planned.storageKey) throw new Error("PRIVATE_STORAGE_IDENTITY_MISMATCH");
    return await prisma.$transaction(async tx => {
      await scopeAccess(tx, userId, scope, true);
      await tx.collaborationFile.update({ where: { id: saved.id }, data: { scanStatus: "CLEAN" } });
      return { id: saved.id };
    });
  } catch {
    await prisma.collaborationFile.updateMany({ where: { id: saved.id, scanStatus: "STORING" }, data: { scanStatus: "QUARANTINED" } });
    throw new MarketplaceError("The upload could not be finalized. Its private copy remains quarantined for recovery.", 503);
  }
}
export async function readCollaborationFile(userId: string, id: string) {
  const file = await prisma.$transaction(async tx => {
    const row = await tx.collaborationFile.findUnique({ where: { id } });
    if (!row || row.deletedAt || row.scanStatus !== "CLEAN") throw new MarketplaceError("Not found.", 404);
    await scopeAccess(tx, userId, row);
    await audit(tx, userId, "collaboration.file.read", "CollaborationFile", id);
    return row;
  });
  const result = await readPrivateDocument(file.storageKey);
  await prisma.$transaction(async tx => {
    const current = await tx.collaborationFile.findUnique({ where: { id } });
    if (!current || current.deletedAt || current.scanStatus !== "CLEAN" || current.storageKey !== file.storageKey || current.mimeType !== file.mimeType || current.sha256 !== file.sha256 || current.caseId !== file.caseId || current.conversationId !== file.conversationId || current.uploadedById !== file.uploadedById) throw new MarketplaceError("Not found.", 404);
    await scopeAccess(tx, userId, current);
  });
  await result.revalidate();
  return { buffer: result.buffer, mimeType: file.mimeType };
}
