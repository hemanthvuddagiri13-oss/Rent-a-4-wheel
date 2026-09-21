import { reservationEvidenceHeld, reservationHeldSql, noticeReservationSql } from "@/lib/reservation-retention";
import { lockReservation } from "@/lib/financial-locks";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deletePrivateDocument } from "@/lib/storage";
import { afterDays, policy } from "@/lib/collaboration-access";
import { lockRetentionPolicy,retentionApproved,retentionScopeFilter } from "@/lib/retention-policy";

export async function lockFileRetention(tx: Prisma.TransactionClient, fileId: string) {
  await lockRetentionPolicy(tx);
  const f = await tx.collaborationFile.findUniqueOrThrow({ where: { id: fileId } });
  const scope = f.conversationId ? await tx.conversation.findUniqueOrThrow({where:{id:f.conversationId},select:{reservationId:true}}) : await tx.serviceCase.findUniqueOrThrow({where:{id:f.caseId!},select:{reservationId:true}});
  if (scope.reservationId) await lockReservation(tx,scope.reservationId);
  if (f.conversationId) await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${f.conversationId} FOR UPDATE`;
  if (f.caseId) await tx.$queryRaw`SELECT "id" FROM "ServiceCase" WHERE "id"=${f.caseId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CollaborationFile" WHERE "id"=${fileId} FOR UPDATE`;
}
export async function fileHeld(tx: Prisma.TransactionClient, fileId: string) {
  const f = await tx.collaborationFile.findUniqueOrThrow({ where: { id: fileId } });
  if (f.legalHold || f.retainUntil > new Date()) return true;
  if (f.conversationId) {
    const c = await tx.conversation.findUniqueOrThrow({ where: { id: f.conversationId } });
    if (c.legalHold || c.reservationId && !c.closedAt || c.retainUntil > new Date() || await reservationEvidenceHeld(tx, c.reservationId) || !await retentionApproved(tx,c.reservationId)) return true;
  }
  if (f.caseId) {
    const c = await tx.serviceCase.findUniqueOrThrow({ where: { id: f.caseId } });
    if (c.legalHold || c.securityHold || c.state !== "CLOSED" || c.retainUntil > new Date() || await reservationEvidenceHeld(tx, c.reservationId) || !await retentionApproved(tx,c.reservationId)) return true;
  }
  return false;
}
export async function runCollaborationRetention() {
  const p = await policy(prisma),approvedScope=await retentionScopeFilter();
  const terminal = await prisma.$queryRaw<Array<{id:string}>>`SELECT c.id FROM "Conversation" c JOIN "Reservation" r ON r.id=c."reservationId" WHERE c."closedAt" IS NULL AND r.status IN ('COMPLETED','EXPIRED','CANCELLED_BY_CUSTOMER','CANCELLED_BY_HOST') ORDER BY c."createdAt",c.id LIMIT 100`;
  await prisma.conversation.updateMany({ where: { id: { in: terminal.map(r => r.id) }, closedAt: null }, data: { closedAt: new Date(), retainUntil: afterDays(p.messageDays) } });
  // Filter held records before limiting the batch: an old legal hold must not
  // permanently starve later eligible records. Authorization is checked again
  // under parent/file locks at the irreversible deletion point.
  const eligibleFiles = await prisma.$queryRaw<Array<{id:string}>>`SELECT f.id FROM "CollaborationFile" f LEFT JOIN "Conversation" c ON c.id=f."conversationId" LEFT JOIN "ServiceCase" s ON s.id=f."caseId" WHERE f."retainUntil"<=now() AND f."deletedAt" IS NULL AND NOT f."legalHold" AND (c.id IS NULL OR (NOT c."legalHold" AND c."retainUntil"<=now() AND (c."reservationId" IS NULL OR c."closedAt" IS NOT NULL))) AND (s.id IS NULL OR (s.state='CLOSED' AND NOT s."legalHold" AND NOT s."securityHold" AND s."retainUntil"<=now())) AND ${approvedScope(Prisma.sql`COALESCE(c."reservationId",s."reservationId")`)} AND NOT ${reservationHeldSql(Prisma.sql`COALESCE(c."reservationId",s."reservationId")`)} ORDER BY f."retainUntil",f.id LIMIT 100`;
  const files = await prisma.collaborationFile.findMany({where:{id:{in:eligibleFiles.map(f=>f.id)}}});
  for (const f of files) await prisma.$transaction(async tx => {
    await lockFileRetention(tx,f.id);
    if (!await fileHeld(tx,f.id)) await tx.storageDeletionJob.upsert({where:{fileId:f.id},update:{},create:{fileId:f.id}});
  });
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
  const eligibleConversations = await prisma.$queryRaw<Array<{id:string}>>`SELECT c.id FROM "Conversation" c WHERE NOT c."legalHold" AND c."retainUntil"<now() AND (c."reservationId" IS NULL OR c."closedAt" IS NOT NULL) AND EXISTS (SELECT 1 FROM "ConversationMessage" m WHERE m."conversationId"=c.id) AND ${approvedScope(Prisma.sql`c."reservationId"`)} AND NOT ${reservationHeldSql(Prisma.sql`c."reservationId"`)} ORDER BY c."retainUntil",c.id LIMIT 50`;
  const conversations = await prisma.conversation.findMany({where:{id:{in:eligibleConversations.map(c=>c.id)}}});
  for (const c of conversations) await prisma.$transaction(async tx => {
    await lockRetentionPolicy(tx);if(!await retentionApproved(tx,c.reservationId))return;
    if(c.reservationId) await lockReservation(tx,c.reservationId);
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${c.id} FOR UPDATE`;
    const current = await tx.conversation.findUniqueOrThrow({ where: { id: c.id } });
    if (current.legalHold || current.retainUntil > new Date() || current.reservationId && !current.closedAt || await reservationEvidenceHeld(tx, current.reservationId)) return;
    await tx.messageRevision.deleteMany({ where: { message: { conversationId: c.id } } });
    await tx.conversationMessage.deleteMany({ where: { conversationId: c.id } });
    await tx.auditLog.create({ data: { action: "retention.messages.purged", entityType: "Conversation", entityId: c.id } });
  });
  const eligibleCases = await prisma.$queryRaw<Array<{id:string}>>`SELECT c.id FROM "ServiceCase" c WHERE c.state='CLOSED' AND NOT c."legalHold" AND NOT c."securityHold" AND c."retainUntil"<now() AND EXISTS (SELECT 1 FROM "ServiceCaseEvent" e WHERE e."caseId"=c.id) AND ${approvedScope(Prisma.sql`c."reservationId"`)} AND NOT ${reservationHeldSql(Prisma.sql`c."reservationId"`)} ORDER BY c."retainUntil",c.id LIMIT 50`;
  const cases = await prisma.serviceCase.findMany({where:{id:{in:eligibleCases.map(c=>c.id)}}});
  for (const c of cases) await prisma.$transaction(async tx => {
    await lockRetentionPolicy(tx);if(!await retentionApproved(tx,c.reservationId))return;
    if(c.reservationId) await lockReservation(tx,c.reservationId);
    await tx.$queryRaw`SELECT "id" FROM "ServiceCase" WHERE "id"=${c.id} FOR UPDATE`;
    const current = await tx.serviceCase.findUniqueOrThrow({ where: { id: c.id } });
    if (current.state !== "CLOSED" || current.legalHold || current.securityHold || current.retainUntil > new Date() || await reservationEvidenceHeld(tx, current.reservationId)) return;
    await tx.serviceCaseEvent.deleteMany({ where: { caseId: c.id } });
    await tx.serviceCase.update({ where: { id: c.id }, data: { title: "Record retained without content", details: { purged: true }, version: { increment: 1 } } });
    await tx.auditLog.create({ data: { action: "retention.case_content.purged", entityType: "ServiceCase", entityId: c.id } });
  });
  const reviews = await prisma.$queryRaw<Array<{id:string;reservationId:string}>>`SELECT t.id,t."reservationId" FROM "TripReview" t WHERE t."retainUntil"<now() AND NOT t."legalHold" AND t.body<>'' AND ${approvedScope(Prisma.sql`t."reservationId"`)} AND NOT ${reservationHeldSql(Prisma.sql`t."reservationId"`)} ORDER BY t."retainUntil",t.id LIMIT 50`;
  for (const r of reviews) await prisma.$transaction(async tx => {
    await lockRetentionPolicy(tx);if(!await retentionApproved(tx,r.reservationId))return;
    await lockReservation(tx, r.reservationId);
    await tx.$queryRaw`SELECT "id" FROM "TripReview" WHERE "id"=${r.id} FOR UPDATE`;
    const current = await tx.tripReview.findUniqueOrThrow({ where: { id: r.id } });
    if (!current.body || current.legalHold || current.retainUntil > new Date() || await reservationEvidenceHeld(tx, current.reservationId)) return;
    // Immutable author/moderation history remains protected audit evidence.
    // This expires public content, not an assertion of complete privacy erasure.
    await tx.tripReview.update({ where: { id: r.id }, data: { body: "", hidden: true, categories: {} } });
    await tx.auditLog.create({ data: { action: "retention.review_content.purged", entityType: "TripReview", entityId: r.id } });
  });
  const cutoff = new Date(Date.now() - p.deliveryDays * 86400000);
  const deliveries = await prisma.$queryRaw<Array<{id:string;reservationId:string}>>`SELECT d.id,${noticeReservationSql} AS "reservationId" FROM "ChannelDelivery" d JOIN "InboxNotice" n ON n.id=d."noticeId" WHERE d."createdAt"<${cutoff} AND d.state IN ('ACCEPTED','OPTED_OUT') AND ${noticeReservationSql} IS NOT NULL AND ${approvedScope(noticeReservationSql)} AND NOT ${reservationHeldSql(noticeReservationSql)} ORDER BY d."createdAt",d.id LIMIT 100`;
  for (const d of deliveries) await prisma.$transaction(async tx => {
    await lockRetentionPolicy(tx);if(!await retentionApproved(tx,d.reservationId))return;
    await lockReservation(tx, d.reservationId);
    if (await reservationEvidenceHeld(tx, d.reservationId)) return;
    await tx.channelDelivery.updateMany({ where: { id:d.id, createdAt:{lt:cutoff}, state:{in:["ACCEPTED","OPTED_OUT"]} }, data:{state:"RETAINED_TOMBSTONE",providerId:null,errorCode:null,leaseToken:null,leaseUntil:null} });
  });
  await prisma.privacyDeletion.updateMany({ where: { state: "REQUESTED" }, data: { state: "RETENTION_REVIEW_REQUIRED" } });
  return { scanned: files.length, deleted, conversations: conversations.length, cases: cases.length, reviews: reviews.length };
}
