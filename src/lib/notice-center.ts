import { financeAdmin } from "@/lib/finance-access";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueOutboxNotification, noticeCategory } from "@/lib/outbox";
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
    if (notice.resourceType === "FINANCE") {
      await financeAdmin(tx,userId);
      target = "/finance/admin/reconciliation";
    } else if (notice.resourceType === "CONVERSATION") {
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
  const pending = await prisma.$queryRaw<Array<{id:string}>>`SELECT n.id FROM "Notification" n LEFT JOIN "InboxNotice" i ON i."userId"=n."userId" AND i."eventKey"=CASE WHEN n."deliveryKey" IS NULL THEN 'transaction:'||n.id ELSE 'outbox:'||n."deliveryKey" END WHERE n."userId" IS NOT NULL AND n."reservationId" IS NOT NULL AND i.id IS NULL ORDER BY n."createdAt",n.id LIMIT 100`;
  const rows = await prisma.notification.findMany({ where: { id: { in: pending.map(r=>r.id) } } });
  for (const n of rows) await prisma.inboxNotice.upsert({ where: { eventKey_userId: { eventKey: n.deliveryKey ? `outbox:${n.deliveryKey}` : `transaction:${n.id}`, userId: n.userId! } }, update: {}, create: { eventKey: n.deliveryKey ? `outbox:${n.deliveryKey}` : `transaction:${n.id}`, userId: n.userId!, category: noticeCategory(n.type), title: n.subject ?? "Reservation update", resourceType: "RESERVATION", resourceId: n.reservationId!, required: true } });
  const notices = await prisma.$queryRaw<Array<{ userId:string;category:string;eventKey:string;required:boolean }>>`SELECT n."userId",n.category,n."eventKey",n.required FROM "InboxNotice" n JOIN "User" u ON u.id=n."userId" AND u."isActive"=true LEFT JOIN "OutboxMessage" o ON o."deliveryKey"='community:'||n."userId"||':'||n."eventKey" LEFT JOIN "NoticePreference" p ON p."userId"=n."userId" AND p.category=n.category WHERE n.category IN ('TRIP','DOCUMENT','AGREEMENT','MAINTENANCE') AND n."eventKey" NOT LIKE 'outbox:%' AND n."eventKey" NOT LIKE 'transaction:%' AND o.id IS NULL AND (n.required OR COALESCE(p.email,true)) ORDER BY n."createdAt",n.id LIMIT 100`;
  for (const n of notices) await prisma.$transaction(tx=>enqueueNoticeEmail(tx,n.userId,n.category,n.eventKey,n.required));
  const upcomingIds = await prisma.$queryRaw<Array<{id:string}>>`SELECT r.id FROM "Reservation" r WHERE ((r.status IN ('CONFIRMED','DOCUMENTS_REQUIRED','READY_FOR_CHECK_IN','CHECK_IN_PROGRESS','READY_TO_START') AND r."pickupAt">now() AND r."pickupAt"<now()+interval '1 day') OR (r.status='ACTIVE' AND r."returnAt">now() AND r."returnAt"<now()+interval '1 day')) AND NOT EXISTS (SELECT 1 FROM "InboxNotice" n WHERE n."resourceId"=r.id AND n."eventKey" LIKE CASE WHEN r.status='ACTIVE' THEN 'return-reminder:' ELSE 'pickup-reminder:' END || r.id || ':%') ORDER BY r."pickupAt",r.id LIMIT 100`;
  const upcoming = await prisma.reservation.findMany({where:{id:{in:upcomingIds.map(r=>r.id)}}});
  for (const r of upcoming) { const eventKey = (r.status==="ACTIVE"?"return-reminder:":"pickup-reminder:")+r.id+":"+(r.status==="ACTIVE"?r.returnAt:r.pickupAt).toISOString();await prisma.$queryRaw`SELECT community_reservation_notice(${r.id},${eventKey},${r.status==="ACTIVE"?"Your trip return is approaching":"Your pickup is approaching"},'TRIP')::text`; }
  return { projected: rows.length, emailsPlanned: notices.length, reminders: upcoming.length };
}
