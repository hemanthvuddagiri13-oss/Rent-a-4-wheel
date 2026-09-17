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
      if (data.entity === "FILE") {
        await lockFileRetention(tx, data.id);
        const file = await tx.collaborationFile.findUniqueOrThrow({ where: { id: data.id } });
        if (file.deletedAt) throw new MarketplaceError("This file has already passed its deletion deadline.", 409);
        await tx.collaborationFile.update({ where: { id: data.id }, data: { legalHold } });
      } else if (data.entity === "CASE") await tx.serviceCase.update({ where: { id: data.id }, data: { legalHold } });
      else if (data.entity === "CONVERSATION") await tx.conversation.update({ where: { id: data.id }, data: { legalHold } });
      else await tx.tripReview.update({ where: { id: data.id }, data: { legalHold } });
      await tx.auditLog.create({ data: { actorId: userId, action: "retention.hold", entityType: data.entity, entityId: data.id, metadata: { legalHold, reason: safeText(data.reason) } } });
    } else {
      await tx.communityReport.update({ where: { id: data.id }, data: { status: "REVIEWED" } });
      await tx.auditLog.create({ data: { actorId: userId, action: "abuse.reviewed", entityType: "CommunityReport", entityId: data.id, metadata: { reason: safeText(data.reason) } } });
    }
    await audit(tx, userId, `community.admin.${data.command}`, "SiteSetting", "collaboration");
    return { success: true };
  });
}
