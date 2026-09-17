import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deletePrivateDocument } from "@/lib/storage";

async function reservationEvidenceHeld(tx: Prisma.TransactionClient, reservationId: string | null) {
  if (!reservationId) return false;
  // Financial and executed-agreement retention requires a separate legal release;
  // ordinary customer deletion requests never bypass it.
  return Boolean(await tx.payment.count({ where: { reservationId } }) || await tx.agreementAcceptance.count({ where: { reservationId } }) || await tx.serviceCase.count({ where: { reservationId, OR: [{ legalHold: true }, { securityHold: true }, { state: { not: "CLOSED" } }] } }));
}
export async function lockFileRetention(tx: Prisma.TransactionClient, fileId: string) {
  const f = await tx.collaborationFile.findUniqueOrThrow({ where: { id: fileId } });
  if (f.conversationId) await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${f.conversationId} FOR UPDATE`;
  if (f.caseId) await tx.$queryRaw`SELECT "id" FROM "ServiceCase" WHERE "id"=${f.caseId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CollaborationFile" WHERE "id"=${fileId} FOR UPDATE`;
}
export async function fileHeld(tx: Prisma.TransactionClient, fileId: string) {
  const f = await tx.collaborationFile.findUniqueOrThrow({ where: { id: fileId } });
  if (f.legalHold || f.retainUntil > new Date()) return true;
  if (f.conversationId) {
    const c = await tx.conversation.findUniqueOrThrow({ where: { id: f.conversationId } });
    if (c.legalHold || c.retainUntil > new Date() || await reservationEvidenceHeld(tx, c.reservationId)) return true;
  }
  if (f.caseId) {
    const c = await tx.serviceCase.findUniqueOrThrow({ where: { id: f.caseId } });
    if (c.legalHold || c.securityHold || c.state !== "CLOSED" || c.retainUntil > new Date() || await reservationEvidenceHeld(tx, c.reservationId)) return true;
  }
  return false;
}
export async function runCollaborationRetention() {
  const files = await prisma.collaborationFile.findMany({ where: { retainUntil: { lte: new Date() }, deletedAt: null }, take: 100 });
  for (const f of files) if (!await fileHeld(prisma, f.id)) await prisma.storageDeletionJob.upsert({ where: { fileId: f.id }, update: {}, create: { fileId: f.id } });
  const jobs = await prisma.storageDeletionJob.findMany({ where: { state: "PENDING", nextAttemptAt: { lte: new Date() } }, take: 50 });
  let deleted = 0;
  for (const job of jobs) {
    try {
      await prisma.$transaction(async tx => {
        // Keep the private-file lock through deletion, fencing concurrent workers
        // and hold changes. Lost response retries use provider idempotent deletion.
        await lockFileRetention(tx, job.fileId);
        const token = randomUUID();
        const claimed = await tx.storageDeletionJob.updateMany({ where: { id: job.id, state: "PENDING", attempts: job.attempts }, data: { state: "RUNNING", leaseToken: token, leaseUntil: new Date(Date.now() + 120000), attempts: { increment: 1 } } });
        if (!claimed.count) return;
        if (await fileHeld(tx, job.fileId)) { await tx.storageDeletionJob.update({ where: { id: job.id }, data: { state: "PENDING", leaseToken: null, nextAttemptAt: new Date(Date.now() + 86400000) } }); return; }
        const file = await tx.collaborationFile.findUniqueOrThrow({ where: { id: job.fileId } });
        await deletePrivateDocument(file.storageKey);
        await tx.collaborationFile.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
        await tx.storageDeletionJob.update({ where: { id: job.id }, data: { state: "DONE", completedAt: new Date(), leaseToken: null, leaseUntil: null } });
        await tx.auditLog.create({ data: { action: "retention.private_file.deleted", entityType: "CollaborationFile", entityId: file.id } });
        deleted++;
      }, { timeout: 15000 });
    } catch {
      await prisma.storageDeletionJob.updateMany({ where: { id: job.id, state: "PENDING", attempts: job.attempts }, data: { attempts: { increment: 1 }, state: job.attempts >= 4 ? "DEAD_LETTER" : "PENDING", errorCode: "PRIVATE_DELETE_FAILED", nextAttemptAt: new Date(Date.now() + 60000) } });
    }
  }
  return { scanned: files.length, deleted };
}
