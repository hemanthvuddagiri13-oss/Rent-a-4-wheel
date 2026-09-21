import { safeErrorCode } from "@/lib/safe-log";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { queueNotification } from "@/lib/notifications";
export function noticeCategory(type?: NotificationType) {
  if (["PAYMENT_RECEIPT","DEPOSIT_AUTH_FAILED","REFUND"].includes(type ?? "")) return "PAYMENT";
  if (type === "DRIVER_VERIFICATION_REQUEST") return "DOCUMENT";
  if (["UPCOMING_RENTAL_REMINDER","PICKUP_REMINDER","RETURN_REMINDER","LATE_RETURN","TRIP_EMERGENCY_OVERRIDE"].includes(type ?? "")) return "TRIP";
  return "BOOKING";
}
export type OutboxNotificationPayload = { userId?: string; reservationId?: string; type?: NotificationType; extra?: Record<string, unknown> };
export async function enqueueOutboxNotification(tx: Prisma.TransactionClient, payload: OutboxNotificationPayload, deliveryKey?: string) {
  const message = deliveryKey ? await tx.outboxMessage.upsert({ where: { deliveryKey }, update: {}, create: { type: "notification", deliveryKey, payload: payload as Prisma.InputJsonValue } })
  : await tx.outboxMessage.create({ data: { type: "notification", payload: payload as Prisma.InputJsonValue } });
  if (payload.userId && payload.reservationId && payload.type !== "COMMUNITY_UPDATE") await tx.inboxNotice.upsert({ where: { eventKey_userId: { eventKey: "outbox:" + message.id, userId: payload.userId } }, update: {}, create: { eventKey: "outbox:" + message.id, userId: payload.userId, category: noticeCategory(payload.type), resourceType: "RESERVATION", resourceId: payload.reservationId, title: (payload.type ?? "Reservation update").replaceAll("_", " "), required: true } });
}
export async function processOutboxOnce(limit = 50, ids?: string[], db: PrismaClient = prisma) {
  const now = new Date();
  const candidates = await db.outboxMessage.findMany({ where: { ...(ids ? { id: { in: ids } } : {}), status: "PENDING", AND: [
    { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
    { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
  ] }, orderBy: { createdAt: "asc" }, take: limit });
  let processed = 0, failed = 0;
  for (const message of candidates) {
    const token = randomUUID();
    const firstAttemptAt = message.firstAttemptAt ?? (message.attempts > 0 ? message.createdAt : new Date());
    const claim = await db.outboxMessage.updateMany({
      where: { id: message.id, status: "PENDING", attempts: message.attempts, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] },
      data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 120000), firstAttemptAt, attempts: { increment: 1 } },
    });
    if (!claim.count) continue;
    try {
      if(message.type==="finance_schedule"){
        const {executeScheduledPayout}=await import("@/lib/payout-workers");
        await executeScheduledPayout(message.id,token,message.payload,db);
        processed++;continue;
      }
      if (message.type !== "notification") throw new Error("Unsupported outbox message");
      const p = message.payload as OutboxNotificationPayload;
      if (!p.type) throw new Error("Missing notification type");
      // Resend deduplicates by this immutable ID within its retention window.
      // Beyond that window an ambiguous send is left for manual reconciliation.
      if (message.attempts > 0 && Date.now() - firstAttemptAt.getTime() > 23 * 3600000) throw new Error("Delivery replay window elapsed; manual reconciliation required");
      await queueNotification({ ...p, type: p.type, deliveryKey: message.id, throwOnFailure: true, deferProjection: true });
      const saved = await db.$transaction(async tx => {
        const saved = await tx.outboxMessage.updateMany({ where: { id: message.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } }, data: { status: "SENT", processedAt: new Date(), leaseToken: null, leaseExpiresAt: null } });
        if (saved.count) await tx.notification.updateMany({ where: { deliveryKey: message.id }, data: { status: "SENT", error: null, sentAt: new Date() } });
        return saved;
      });
      processed += saved.count;
    } catch (error) {
      await db.$transaction(async tx => {
      const saved = await tx.outboxMessage.updateMany({ where: { id: message.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } }, data: {
        status: message.attempts >= 4 ? "FAILED" : "PENDING", lastError: safeErrorCode(error), nextRetryAt: new Date(Date.now() + 60000),
        leaseToken: null, leaseExpiresAt: null,
      } });
      if (saved.count) await tx.notification.updateMany({ where: { deliveryKey: message.id, status: { not: "SENT" } }, data: { status: "FAILED", error: safeErrorCode(error) } });
      });
      failed++;
    }
  }
  return { processed, failed };
}
