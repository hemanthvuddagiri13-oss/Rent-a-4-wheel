import { prisma } from "@/lib/prisma";
import { withReservationLock } from "@/lib/financial-locks";
import { requireRefund, settleTerminatedReservation } from "@/lib/stripe-webhook-handlers";

export async function expireStaleReservations(now: Date = new Date()) {
  const rows = await prisma.reservation.findMany({ where: {
    status: { in: ["CHECKOUT_HOLD", "AWAITING_PAYMENT", "PAYMENT_FAILED"] }, expiresAt: { lte: now },
  }, select: { id: true } });
  let expiredCount = 0, refundedCount = 0;
  for (const row of rows) {
    const expired = await withReservationLock(row.id, async tx => {
      const r = await tx.reservation.findUniqueOrThrow({ where: { id: row.id }, include: { payments: true } });
      if (!["CHECKOUT_HOLD", "AWAITING_PAYMENT", "PAYMENT_FAILED"].includes(r.status) || !r.expiresAt || r.expiresAt > now) return false;
      const paid = r.payments.filter(p => p.type === "RENTAL" && p.status === "SUCCEEDED");
      for (const payment of paid) await requireRefund(tx, r.id, payment, "Recovery window expired");
      await tx.reservation.update({ where: { id: r.id }, data: { status: "EXPIRED", expiresAt: null } });
      await tx.tripEvent.create({ data: { reservationId: r.id, type: "HOLD_EXPIRED" } });
      return true;
    });
    if (!expired) continue;
    expiredCount++;
    try {
      await settleTerminatedReservation(row.id);
      if (await prisma.refund.count({ where: { reservationId: row.id, status: "SUCCEEDED" } })) refundedCount++;
    } catch (error) {
      // Intent is already durable; cron retries without releasing the balance.
      console.error("Financial recovery remains pending", row.id, String(error));
    }
  }
  return { expiredCount, refundedCount };
}
