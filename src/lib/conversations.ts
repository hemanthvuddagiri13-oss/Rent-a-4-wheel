import { domainTransaction, type DomainDatabase } from "@/lib/domain-transaction";
import { enqueueNoticeEmail } from "@/lib/notice-center";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MarketplaceError } from "@/lib/marketplace";
import { participant, reservationScope, safeText, policy, afterDays, audit } from "@/lib/collaboration-access";
import {releaseAuthorityFence} from "@/lib/admission-authority";
import {requireVehicleJurisdiction} from "@/lib/jurisdiction";

export async function conversationAccess(tx: Prisma.TransactionClient, userId: string, id: string) {
  const conversation = await tx.conversation.findUnique({ where: { id } });
  if (!conversation) throw new MarketplaceError("Not found.", 404);
  const access = await participant(tx, userId, conversation, "MESSAGE");
  return { conversation, ...access };
}
export async function openConversation(userId: string, input: { reservationId?: string; vehicleId?: string }, db: DomainDatabase = prisma) {
  return domainTransaction(db, async tx => {
    const r = input.reservationId ? await reservationScope(tx, input.reservationId) : null;
    if(!r){
      await releaseAuthorityFence(tx);
      await tx.$queryRaw`SELECT financial_guard_xact(${"vehicle:"+(input.vehicleId??"")})`;
      await requireVehicleJurisdiction(tx,input.vehicleId??"","SEARCH");
    }
    const vehicle = await tx.vehicle.findUnique({ where: { id: r?.vehicleId ?? input.vehicleId ?? "" } });
    if (!vehicle || (!r && (vehicle.status !== "ACTIVE" || vehicle.listingApproval !== "APPROVED" || vehicle.isDemo))) throw new MarketplaceError("Vehicle unavailable.", 404);
    const customerId = r?.customerId ?? userId;
    await participant(tx, userId, { customerId, vehicleId: vehicle.id }, "MESSAGE");
    const p = await policy(tx);
    const data = { reservationId: r?.id, vehicleId: vehicle.id, customerId, retainUntil: afterDays(p.messageDays) };
    const conversation = r ? await tx.conversation.upsert({ where: { reservationId: r.id }, update: {}, create: data }) : await tx.conversation.create({ data });
    await audit(tx, userId, "conversation.open", "Conversation", conversation.id);
    return { id: conversation.id };
  });
}
export async function messageCommand(userId: string, id: string, input: { action: "send" | "edit" | "delete" | "read" | "report"; body?: string; messageId?: string; version?: number }, db: DomainDatabase = prisma) {
  return domainTransaction(db, async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${id} FOR UPDATE`;
    const { conversation } = await conversationAccess(tx, userId, id);
    const p = await policy(tx);
    if (input.action === "read") {
      const latest = await tx.conversationMessage.findFirst({ where: { conversationId: id, ...(input.messageId ? { id: input.messageId } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (input.messageId && !latest) throw new MarketplaceError("Not found.", 404);
      const readAt = latest?.createdAt ?? new Date();
      await tx.conversationRead.upsert({ where: { conversationId_userId: { conversationId: id, userId } }, create: { conversationId: id, userId, readAt }, update: {} });
      await tx.conversationRead.updateMany({ where: { conversationId: id, userId, readAt: { lt: readAt } }, data: { readAt } });
      return { success: true };
    }
    if ((!conversation.reservationId || conversation.closedAt) && conversation.retainUntil < new Date()) throw new MarketplaceError("This conversation is archived.", 409);
    if (input.action === "send") {
      const body = safeText(input.body ?? "");
      const recent = await tx.conversationMessage.count({ where: { senderId: userId, conversationId: id, createdAt: { gt: new Date(Date.now() - 60000) } } });
      if (recent >= 10) throw new MarketplaceError("Please wait before sending more messages.", 429);
      const m = await tx.conversationMessage.create({ data: { conversationId: id, senderId: userId, body } });
      await tx.messageRevision.create({ data: { messageId: m.id, actorId: userId, version: 0, body, action: "SEND" } });
      await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
      const host = await tx.vehicle.findUnique({ where: { id: conversation.vehicleId }, include: { host: true } });
      for (const recipient of new Set([conversation.customerId, host?.host?.userId].filter((v): v is string => Boolean(v) && v !== userId))) {
        await tx.inboxNotice.upsert({ where: { eventKey_userId: { eventKey: `message:${m.id}`, userId: recipient } }, update: {}, create: { eventKey: `message:${m.id}`, userId: recipient, category: "MESSAGE", resourceType: "CONVERSATION", resourceId: id, title: "New private message" } });
        await enqueueNoticeEmail(tx, recipient, "MESSAGE", `message:${m.id}`);
      }
      return { id: m.id };
    }
    const message = await tx.conversationMessage.findFirst({ where: { id: input.messageId, conversationId: id } });
    if (!message) throw new MarketplaceError("Not found.", 404);
    if (input.action === "report") {
      return tx.communityReport.upsert({ where: { actorId_entityType_entityId: { actorId: userId, entityType: "MESSAGE", entityId: message.id } }, update: {}, create: { actorId: userId, entityType: "MESSAGE", entityId: message.id, reason: safeText(input.body ?? "") } });
    }
    if (message.senderId !== userId || message.deletedAt || message.version !== input.version || Date.now() - message.createdAt.getTime() > p.editMinutes * 60000) throw new MarketplaceError("The message cannot be edited. Refresh to see its current state.", 409);
    const body = input.action === "delete" ? "" : safeText(input.body ?? "");
    await tx.messageRevision.create({ data: { messageId: message.id, actorId: userId, version: message.version + 1, body, action: input.action.toUpperCase() } });
    await tx.conversationMessage.update({ where: { id: message.id }, data: { body, version: { increment: 1 }, editedAt: new Date(), ...(input.action === "delete" ? { deletedAt: new Date() } : {}) } });
    await audit(tx, userId, `message.${input.action}`, "ConversationMessage", message.id);
    return { id: message.id };
  });
}
export async function readConversation(userId: string, id: string, before?: string) {
  return prisma.$transaction(async tx => {
    const { conversation, role } = await conversationAccess(tx, userId, id);
    if (before && !await tx.conversationMessage.findFirst({ where: { id: before, conversationId: id } })) throw new MarketplaceError("Invalid conversation page.", 400);
    const messages = await tx.conversationMessage.findMany({ where: { conversationId: id }, ...(before ? { cursor: { id: before }, skip: 1 } : {}), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30, select: { id: true, senderId: true, body: true, createdAt: true, editedAt: true, deletedAt: true, version: true } });
    const senders = await tx.user.findMany({ where: { id: { in: messages.map(m => m.senderId) } }, select: { id: true, name: true, role: true } });
    return { messages: messages.map(m => { const sender = senders.find(s => s.id === m.senderId); return { ...m, senderLabel: sender?.name?.trim().split(/\s+/)[0] || (m.senderId === conversation.customerId ? "Customer" : sender && ["SUPPORT_AGENT", "ADMIN", "SUPER_ADMIN"].includes(sender.role) ? "Support team" : "Host team") }; }), history: role === "OPERATOR" ? await tx.messageRevision.findMany({ where: { message: { conversationId: id } }, orderBy: { createdAt: "desc" }, take: 100 }) : [], reads: await tx.conversationRead.findMany({ where: { conversationId: id } }) };
  });
}
