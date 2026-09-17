import { prisma } from "@/lib/prisma";
import { MAX_DOCUMENT_SIZE_BYTES, validateAndSanitizeDocument, scanForMalware } from "@/lib/documents";
import { storePrivateDocument, readPrivateDocument } from "@/lib/storage";
import { conversationAccess } from "@/lib/conversations";
import { caseAccess } from "@/lib/service-cases";
import { afterDays, audit, policy } from "@/lib/collaboration-access";
import { MarketplaceError } from "@/lib/marketplace";
import type { Prisma } from "@prisma/client";

async function scopeAccess(tx: Prisma.TransactionClient, userId: string, scope: { conversationId?: string | null; caseId?: string | null }) {
  if (Boolean(scope.conversationId) === Boolean(scope.caseId)) throw new MarketplaceError("Choose exactly one conversation or case.");
  if (scope.conversationId) await conversationAccess(tx, userId, scope.conversationId);
  if (scope.caseId) await caseAccess(tx, userId, scope.caseId);
}
export async function uploadCollaborationFile(userId: string, scope: { conversationId?: string; caseId?: string }, file: File, purpose: string) {
  await scopeAccess(prisma, userId, scope);
  if (!["MESSAGE", "DAMAGE", "ESTIMATE", "INVOICE", "POLICE_REPORT", "SUPPORT"].includes(purpose)) throw new MarketplaceError("Choose a supported attachment purpose.");
  if (file.size > MAX_DOCUMENT_SIZE_BYTES) throw new MarketplaceError("Choose an image smaller than 8 MB.");
  const clean = await validateAndSanitizeDocument(Buffer.from(await file.arrayBuffer()), file.type);
  if ((await scanForMalware(clean.buffer)).status !== "CLEAN") throw new MarketplaceError("The security scan did not approve this file. Try again later.", 422);
  // Scanning is outside the transaction; repeat current authorization afterwards.
  // No driver-document IDs/storage keys are accepted in this API.
  return prisma.$transaction(async tx => {
    await scopeAccess(tx, userId, scope);
    const p = await policy(tx);
    const stored = await storePrivateDocument(clean.buffer, clean.mimeType);
    const saved = await tx.collaborationFile.create({ data: { ...scope, uploadedById: userId, purpose, storageKey: stored.storageKey, mimeType: clean.mimeType, sha256: clean.sha256, size: clean.buffer.length, scanStatus: "CLEAN", retainUntil: afterDays(p.retentionDays) } });
    await audit(tx, userId, "collaboration.file.upload", "CollaborationFile", saved.id);
    return { id: saved.id };
  }, { timeout: 15000 });
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
  return { buffer: result.buffer, mimeType: file.mimeType };
}
