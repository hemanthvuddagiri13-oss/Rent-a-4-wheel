import { prisma } from "@/lib/prisma";
import { transitionReservation } from "@/lib/reservation-state-machine";

/**
 * Sweeps reservations whose checkout-hold/payment window has passed and
 * flips them to EXPIRED. This is a cleanliness/reporting pass, not the
 * primary safety mechanism — `isVehicleAvailable()` already filters out
 * expired holds in real time by checking `expiresAt` directly, so a
 * customer is never blocked by a hold that merely hasn't been swept yet.
 * Intended to run on a schedule (see README "Background Jobs" for how to
 * wire a real cron trigger against `/api/cron/expire-holds`).
 */
export async function expireStaleReservations(now: Date = new Date()): Promise<{ expiredCount: number }> {
  const stale = await prisma.reservation.findMany({
    where: {
      status: { in: ["CHECKOUT_HOLD", "AWAITING_PAYMENT"] },
      expiresAt: { lt: now },
    },
    select: { id: true, status: true },
  });

  let expiredCount = 0;
  for (const reservation of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        await transitionReservation(tx, {
          id: reservation.id,
          from: reservation.status,
          to: "EXPIRED",
          data: { expiresAt: null },
        });
        await tx.tripEvent.create({ data: { reservationId: reservation.id, type: "HOLD_EXPIRED" } });
      });
      expiredCount += 1;
    } catch {
      // Already transitioned by a concurrent sweep or a customer action —
      // safe to skip.
    }
  }

  return { expiredCount };
}
