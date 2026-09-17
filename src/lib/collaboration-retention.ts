import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deletePrivateDocument } from "@/lib/storage";
import { afterDays, policy } from "@/lib/collaboration-access";

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
    if (c.legalHold || c.reservationId && !c.closedAt || c.retainUntil > new Date() || await reservationEvidenceHeld(tx, c.reservationId)) return true;
  }
  if (f.caseId) {
    const c = await tx.serviceCase.findUniqueOrThrow({ where: { id: f.caseId } });
    if (c.legalHold || c.securityHold || c.state !== "CLOSED" || c.retainUntil > new Date() || await reservationEvidenceHeld(tx, c.reservationId)) return true;
  }
  return false;
}
export async function runCollaborationRetention() {
  const p = await policy(prisma);
  const terminal = await prisma.reservation.findMany({ where: { status: { in: ["COMPLETED", "EXPIRED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"] } }, select: { id: true } });
  await prisma.conversation.updateMany({ where: { reservationId: { in: terminal.map(r => r.id) }, closedAt: null }, data: { closedAt: new Date(), retainUntil: afterDays(p.messageDays) } });
  const files = await prisma.collaborationFile.findMany({ where: { retainUntil: { lte: new Date() }, deletedAt: null }, take: 100 });
  for (const f of files) if (!await fileHeld(prisma, f.id)) await prisma.storageDeletionJob.upsert({ where: { fileId: f.id }, update: {}, create: { fileId: f.id } });
  const jobs = await prisma.storageDeletionJob.findMany({ where: { OR: [{ state: "PENDING", nextAttemptAt: { lte: new Date() } }, { state: "RUNNING", leaseUntil: { lt: new Date() } }] }, take: 50 });
  let deleted = 0;
  for (const job of jobs) {
    const token = randomUUID();
    const file = await prisma.$transaction(async tx => {
      await lockFileRetention(tx, job.fileId);
      const current = await tx.collaborationFile.findUniqueOrThrow({ where: { id: job.fileId } });
      const claimWhere = { id: job.id, attempts: job.attempts, OR: [{ state: "PENDING" }, { state: "RUNNING", leaseUntil: { lt: new Date() } }] };
      if (current.scanStatus !== "DELETION_COMMITTED" && await fileHeld(tx, job.fileId)) {
        await tx.storageDeletionJob.updateMany({ where: claimWhere, data: { state: "PENDING", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now()+86400000) } });return null;
      }
      const claimed = await tx.storageDeletionJob.updateMany({ where: claimWhere, data: { state: "RUNNING", leaseToken: token, leaseUntil: new Date(Date.now()+120000), attempts: { increment: 1 } } });
      if (!claimed.count) return null;
      // This durable logical deletion is the irreversible authorization point.
      // A later hold cannot revive a file while a provider delete is in flight.
      if (current.scanStatus !== "DELETION_COMMITTED") {
        await tx.collaborationFile.update({ where: { id: current.id }, data: { scanStatus: "DELETION_COMMITTED", deletedAt: new Date() } });
        await tx.auditLog.create({ data: { action: "retention.private_file.deletion_committed", entityType: "CollaborationFile", entityId: current.id } });
      }
      return current;
    });
    if (!file) continue;
    try {
      // Idempotent exact-key deletion can safely resume an uncertain outcome.
      await deletePrivateDocument(file.storageKey);
      deleted += await prisma.$transaction(async tx => {
        const saved = await tx.storageDeletionJob.updateMany({ where: { id: job.id, state: "RUNNING", leaseToken: token, leaseUntil: { gt: new Date() } }, data: { state: "DONE", completedAt: new Date(), leaseToken: null, leaseUntil: null } });
        if (saved.count) await tx.auditLog.create({ data: { action: "retention.private_file.deleted", entityType: "CollaborationFile", entityId: file.id } });
        return saved.count;
      });
    } catch {
      await prisma.storageDeletionJob.updateMany({ where: { id: job.id, state: "RUNNING", leaseToken: token }, data: { state: job.attempts >= 4 ? "DEAD_LETTER" : "PENDING", leaseToken: null, leaseUntil: null, errorCode: "PRIVATE_DELETE_FAILED", nextAttemptAt: new Date(Date.now()+60000) } });
    }
  }
  const conversations = await prisma.conversation.findMany({ where: { legalHold: false, retainUntil: { lt: new Date() }, messages: { some: {} } }, take: 50 });
  for (const c of conversations) await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${c.id} FOR UPDATE`;
    const current = await tx.conversation.findUniqueOrThrow({ where: { id: c.id } });
    if (current.legalHold || current.retainUntil > new Date() || current.reservationId && !current.closedAt || await reservationEvidenceHeld(tx, current.reservationId)) return;
    await tx.messageRevision.deleteMany({ where: { message: { conversationId: c.id } } });
    await tx.conversationMessage.deleteMany({ where: { conversationId: c.id } });
    await tx.auditLog.create({ data: { action: "retention.messages.purged", entityType: "Conversation", entityId: c.id } });
  });
  const cases = await prisma.serviceCase.findMany({ where: { state: "CLOSED", legalHold: false, securityHold: false, retainUntil: { lt: new Date() }, events: { some: {} } }, take: 50 });
  for (const c of cases) await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ServiceCase" WHERE "id"=${c.id} FOR UPDATE`;
    const current = await tx.serviceCase.findUniqueOrThrow({ where: { id: c.id } });
    if (current.state !== "CLOSED" || current.legalHold || current.securityHold || current.retainUntil > new Date() || await reservationEvidenceHeld(tx, current.reservationId)) return;
    await tx.serviceCaseEvent.deleteMany({ where: { caseId: c.id } });
    await tx.serviceCase.update({ where: { id: c.id }, data: { title: "Record retained without content", details: { purged: true }, version: { increment: 1 } } });
    await tx.auditLog.create({ data: { action: "retention.case_content.purged", entityType: "ServiceCase", entityId: c.id } });
  });
  const reviews = await prisma.tripReview.findMany({ where: { retainUntil: { lt: new Date() }, legalHold: false, body: { not: "" } }, take: 50 });
  for (const r of reviews) await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "TripReview" WHERE "id"=${r.id} FOR UPDATE`;
    const current = await tx.tripReview.findUniqueOrThrow({ where: { id: r.id } });
    if (current.legalHold || current.retainUntil > new Date()) return;
    await tx.reviewHistory.deleteMany({ where: { reviewId: r.id } });
    await tx.tripReview.update({ where: { id: r.id }, data: { body: "", hidden: true, categories: {} } });
    await tx.auditLog.create({ data: { action: "retention.review_content.purged", entityType: "TripReview", entityId: r.id } });
  });
  const cutoff = new Date(Date.now() - p.deliveryDays * 86400000);
  await prisma.channelDelivery.updateMany({ where: { createdAt: { lt: cutoff }, state: { in: ["ACCEPTED", "OPTED_OUT"] } }, data: { state: "RETAINED_TOMBSTONE", providerId: null, errorCode: null, leaseToken: null, leaseUntil: null } });
  await prisma.privacyDeletion.updateMany({ where: { state: "REQUESTED" }, data: { state: "RETENTION_REVIEW_REQUIRED" } });
  return { scanned: files.length, deleted, conversations: conversations.length, cases: cases.length, reviews: reviews.length };
}
