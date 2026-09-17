import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueOutboxNotification } from "@/lib/outbox";
import { conversationAccess } from "@/lib/conversations";
import { caseAccess } from "@/lib/service-cases";
import { marketplaceActor, MarketplaceError } from "@/lib/marketplace";
import { participant, reservationScope } from "@/lib/collaboration-access";

export async function enqueueNoticeEmail(tx: Prisma.TransactionClient, userId: string, category: string, eventKey: string, required = false) {
  const pref = await tx.noticePreference.findUnique({ where: { userId_category: { userId, category } } });
  if (required || pref?.email !== false) await enqueueOutboxNotification(tx, { userId, type: "COMMUNITY_UPDATE" }, `community:${userId}:${eventKey}`);
}
export async function noticeTarget(userId: string, id: string) {
  return prisma.$transaction(async tx => {
    await marketplaceActor(tx, userId);
    const notice = await tx.inboxNotice.findFirst({ where: { id, userId } });
    if (!notice) throw new MarketplaceError("Not found.", 404);
    let target = "/connect";
    if (notice.resourceType === "CONVERSATION") {
      await conversationAccess(tx, userId, notice.resourceId);
      target = `/connect/conversations/${notice.resourceId}`;
    } else if (notice.resourceType === "CASE") {
      await caseAccess(tx, userId, notice.resourceId);
      target = `/connect/cases/${notice.resourceId}`;
    } else if (notice.resourceType === "RESERVATION") {
      const r = await reservationScope(tx, notice.resourceId);
      const access = await participant(tx, userId, r, "MESSAGE");
      target = access.role === "CUSTOMER" ? `/account/reservations/${r.id}` : access.role === "HOST" ? `/host/reservations/${r.id}` : `/connect`;
    }
    await tx.inboxNotice.update({ where: { id }, data: { readAt: new Date() } });
    return target;
  });
}

// Projection is idempotent and provider status has no bearing on in-app visibility.
export async function projectTransactionalNotices() {
  const rows = await prisma.notification.findMany({ where: { userId: { not: null }, reservationId: { not: null } }, orderBy: { createdAt: "desc" }, take: 500 });
  for (const n of rows) await prisma.inboxNotice.upsert({ where: { eventKey_userId: { eventKey: `transaction:${n.id}`, userId: n.userId! } }, update: {}, create: { eventKey: `transaction:${n.id}`, userId: n.userId!, category: n.type, title: n.subject ?? "Reservation update", resourceType: "RESERVATION", resourceId: n.reservationId!, required: true } });
  return { projected: rows.length };
}
