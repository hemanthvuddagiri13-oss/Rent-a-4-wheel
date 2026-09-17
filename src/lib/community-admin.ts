import { lockReservation } from "@/lib/financial-locks";
import { lockFileRetention } from "@/lib/collaboration-retention";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { marketplaceActor, MarketplaceError } from "@/lib/marketplace";
import { audit, safeText } from "@/lib/collaboration-access";

export async function communityAdmin(userId: string, input: unknown) {
  const data = z.discriminatedUnion("command", [
    z.object({ command: z.literal("policy"), editMinutes: z.coerce.number().int().min(1).max(60), reviewDays: z.coerce.number().int().min(1).max(90), blindDays: z.coerce.number().int().min(1).max(90), responseHours: z.coerce.number().int().min(1).max(720), retentionDays: z.coerce.number().int().min(30).max(3650), messageDays: z.coerce.number().int().min(30).max(3650).default(1095), attachmentDays: z.coerce.number().int().min(30).max(3650).default(1095), reviewRetentionDays: z.coerce.number().int().min(30).max(3650).default(1095), claimDays: z.coerce.number().int().min(30).max(3650).default(1095), disputeDays: z.coerce.number().int().min(30).max(3650).default(1095), incidentDays: z.coerce.number().int().min(30).max(3650).default(1095), ticketDays: z.coerce.number().int().min(30).max(3650).default(365), deliveryDays: z.coerce.number().int().min(30).max(3650).default(90) }),
    z.object({ command: z.literal("contacts"), roadside: z.string().max(1000), insurance: z.string().max(1000), template: z.string().max(3000) }),
    z.object({ command: z.literal("hold"), id: z.string(), entity: z.enum(["CASE", "CONVERSATION", "FILE", "REVIEW"]), held: z.enum(["yes", "no"]), reason: z.string().min(10).max(1000) }),
    z.object({ command: z.literal("report"), id: z.string(), reason: z.string().min(10).max(1000) }),
    z.object({ command: z.literal("retryDeletion"), id: z.string(), reason: z.string().min(10).max(1000) }),
    z.object({ command: z.literal("privacyReview"), id: z.string(), state: z.enum(["RETAINED_LEGAL_REVIEW", "SCHEDULED_RETENTION"]), reason: z.string().min(10).max(1000) }),
  ]).parse(input);
  return prisma.$transaction(async tx => {
    const actor = await marketplaceActor(tx, userId);
    if (!["ADMIN", "SUPER_ADMIN"].includes(actor.role)) throw new MarketplaceError("Administration permission required.", 403);
    if (data.command === "policy") {
      const { command: _command, ...value } = data; void _command;
      // A blind period at least as long as the author edit window prevents
      // retroactive edits after the other party has seen a review.
      await tx.siteSetting.upsert({ where: { key: "collaboration.policy" }, create: { key: "collaboration.policy", value }, update: { value } });
    } else if (data.command === "contacts") {
      const value = { roadside: safeText(data.roadside), insurance: safeText(data.insurance), template: safeText(data.template) };
      await tx.siteSetting.upsert({ where: { key: "collaboration.contacts" }, create: { key: "collaboration.contacts", value }, update: { value } });
    } else if (data.command === "hold") {
      if (actor.role !== "SUPER_ADMIN") throw new MarketplaceError("Only a super administrator may change retention holds.", 403);
      const legalHold = data.held === "yes";
      if (data.entity !== "FILE") {
        const record = data.entity === "CASE" ? await tx.serviceCase.findUniqueOrThrow({where:{id:data.id}}) : data.entity === "CONVERSATION" ? await tx.conversation.findUniqueOrThrow({where:{id:data.id}}) : await tx.tripReview.findUniqueOrThrow({where:{id:data.id}});
        if (record.reservationId) await lockReservation(tx, record.reservationId);
        // Lock child only after its shared reservation guard.
        if (data.entity === "CASE") await tx.$queryRaw`SELECT id FROM "ServiceCase" WHERE id=${data.id} FOR UPDATE`;
        else if (data.entity === "CONVERSATION") await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id=${data.id} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM "TripReview" WHERE id=${data.id} FOR UPDATE`;
      }
      if (data.entity === "FILE") {
        await lockFileRetention(tx, data.id);
        const file = await tx.collaborationFile.findUniqueOrThrow({ where: { id: data.id } });
        if (file.deletedAt) throw new MarketplaceError("The deletion is already committed and cannot be reversed by a new hold.", 409);
        await tx.collaborationFile.update({ where: { id: data.id }, data: { legalHold } });
      } else if (data.entity === "CASE") await tx.serviceCase.update({ where: { id: data.id }, data: { legalHold } });
      else if (data.entity === "CONVERSATION") await tx.conversation.update({ where: { id: data.id }, data: { legalHold } });
      else await tx.tripReview.update({ where: { id: data.id }, data: { legalHold } });
      await tx.auditLog.create({ data: { actorId: userId, action: "retention.hold", entityType: data.entity, entityId: data.id, metadata: { legalHold, reason: safeText(data.reason) } } });
    } else if (data.command === "retryDeletion") {
      if (actor.role !== "SUPER_ADMIN") throw new MarketplaceError("Super administrator required.", 403);
      const changed = await tx.storageDeletionJob.updateMany({ where: { id: data.id, state: "DEAD_LETTER" }, data: { state: "PENDING", attempts: 0, nextAttemptAt: new Date(), leaseToken: null, leaseUntil: null } });
      if (!changed.count) throw new MarketplaceError("Only a dead-letter deletion may be retried.", 409);
      await tx.auditLog.create({ data: { actorId: userId, action: "retention.deletion.retry", entityType: "StorageDeletionJob", entityId: data.id, metadata: { reason: safeText(data.reason) } } });
    } else if (data.command === "privacyReview") {
      if (actor.role !== "SUPER_ADMIN") throw new MarketplaceError("Super administrator required.", 403);
      const request = await tx.privacyDeletion.findUniqueOrThrow({where:{id:data.id}});
      const reservations = await tx.reservation.findMany({where:{OR:[{customerId:request.userId},{vehicle:{host:{userId:request.userId}}},{id:{in:(await tx.tripReview.findMany({where:{reviewerId:request.userId},select:{reservationId:true}})).map(r=>r.reservationId)}}]},orderBy:[{vehicleId:"asc"},{id:"asc"}],select:{id:true}});
      for (const reservation of reservations) await lockReservation(tx,reservation.id);
      await tx.privacyDeletion.update({ where: { id: data.id }, data: { state: data.state, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: userId, action: "privacy.review", entityType: "PrivacyDeletion", entityId: data.id, metadata: { state: data.state, reason: safeText(data.reason) } } });
      // A review never bypasses the retention worker's per-record legal,
      // security, agreement, and financial holds or promises immediate erasure.
    } else {
      await tx.communityReport.update({ where: { id: data.id }, data: { status: "REVIEWED" } });
      await tx.auditLog.create({ data: { actorId: userId, action: "abuse.reviewed", entityType: "CommunityReport", entityId: data.id, metadata: { reason: safeText(data.reason) } } });
    }
    await audit(tx, userId, `community.admin.${data.command}`, "SiteSetting", "collaboration");
    return { success: true };
  });
}
