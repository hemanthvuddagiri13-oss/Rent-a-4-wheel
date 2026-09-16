import { prisma } from "@/lib/prisma";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { getOrCreateRefundOperation, executeRefundOperation } from "@/lib/refund-operations";
import { enqueueOutboxNotification } from "@/lib/outbox";

/**
 * Sweeps reservations whose checkout-hold/payment window has passed and
 * flips them to EXPIRED. This is a cleanliness/reporting pass, not the
 * primary safety mechanism — `isVehicleAvailable()` already filters out
 * expired holds in real time by checking `expiresAt` directly, so a
 * customer is never blocked by a hold that merely hasn't been swept yet.
 *
 * The CAS condition re-checks `expiresAt < now` at WRITE time (via
 * `whereExtra`), not just at the read a moment earlier that selected this
 * row as a candidate — a hold a customer refreshed in between (same
 * status, new expiresAt) is never expired out from under them.
 *
 * Intended to run on a schedule (see README "Background Jobs" for how to
 * wire a real cron trigger against `/api/cron/expire-holds`).
 */
export async function expireStaleReservations(now: Date = new Date()): Promise<{ expiredCount: number; refundedCount: number }> {
  const staleHolds = await prisma.reservation.findMany({
    where: {
      status: { in: ["CHECKOUT_HOLD", "AWAITING_PAYMENT"] },
      expiresAt: { lt: now },
    },
    select: { id: true, status: true },
  });

  let expiredCount = 0;
  for (const reservation of staleHolds) {
    try {
      await prisma.$transaction(async (tx) => {
        await transitionReservation(tx, {
          id: reservation.id,
          from: reservation.status,
          to: "EXPIRED",
          data: { expiresAt: null },
          whereExtra: { expiresAt: { lt: now } },
        });
        await tx.tripEvent.create({ data: { reservationId: reservation.id, type: "HOLD_EXPIRED" } });
      });
      expiredCount += 1;
    } catch {
      // Already transitioned by a concurrent sweep or a customer action,
      // or refreshed with a new expiresAt between the read above and this
      // write — safe to skip either way.
    }
  }

  // PAYMENT_FAILED rows carry a recovery-deadline `expiresAt` (see
  // src/lib/payment-reconciliation.ts): the customer has that long to
  // retry the deposit before we stop holding the dates. Once it passes
  // with no resolution, automatically refund the rental payment we're
  // still holding (never silently keep money with nothing to show for
  // it) and release the vehicle.
  const staleFailures = await prisma.reservation.findMany({
    where: { status: "PAYMENT_FAILED", expiresAt: { lt: now } },
    select: { id: true },
  });

  let refundedCount = 0;
  for (const { id: reservationId } of staleFailures) {
    try {
      const settled = await settlePaymentFailedRecoveryTimeout(reservationId, now);
      if (settled) refundedCount += 1;
    } catch (err) {
      console.error(`Failed to settle PAYMENT_FAILED recovery timeout for reservation ${reservationId}`, err);
    }
  }

  return { expiredCount, refundedCount };
}

async function settlePaymentFailedRecoveryTimeout(reservationId: string, now: Date): Promise<boolean> {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation || reservation.status !== "PAYMENT_FAILED" || !reservation.expiresAt || reservation.expiresAt >= now) {
    return false; // already resolved, retried, or refreshed by a concurrent request
  }

  const payment = await prisma.payment.findFirst({
    where: { reservationId, type: "RENTAL", status: "SUCCEEDED" },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) {
    // No captured rental payment to refund — just release the dates.
    try {
      await prisma.$transaction(async (tx) => {
        await transitionReservation(tx, {
          id: reservationId,
          from: "PAYMENT_FAILED",
          to: "EXPIRED",
          data: { expiresAt: null },
          whereExtra: { expiresAt: { lt: now } },
        });
        await tx.tripEvent.create({ data: { reservationId, type: "HOLD_EXPIRED" } });
      });
    } catch {
      return false;
    }
    return false;
  }

  const refund = await getOrCreateRefundOperation({
    idempotencyKey: `recovery-timeout-refund-${reservationId}`,
    reservationId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
    reason: "Security deposit could not be authorized within the recovery window.",
  });
  const result = await executeRefundOperation(refund.id, payment.stripePaymentIntentId);
  const refundSucceeded = result.status === "SUCCEEDED" || (result.status === "already_terminal" && result.refund.status === "SUCCEEDED");

  await prisma.$transaction(async (tx) => {
    await transitionReservation(tx, {
      id: reservationId,
      from: "PAYMENT_FAILED",
      to: "EXPIRED",
      data: { expiresAt: null },
      whereExtra: { expiresAt: { lt: now } },
    });
    await tx.paymentReconciliation.create({
      data: {
        reservationId,
        paymentId: payment.id,
        reason: "DEPOSIT_RECOVERY_WINDOW_EXPIRED",
        status: refundSucceeded ? "REFUNDED" : "NEEDS_MANUAL_REVIEW",
        refundId: refund.stripeRefundId ?? undefined,
        detail: { trigger: "recovery_window_timeout" },
      },
    });
    await enqueueOutboxNotification(tx, { userId: reservation.customerId, reservationId, type: "REFUND", extra: { amountCents: payment.amountCents } });
    await tx.tripEvent.create({ data: { reservationId, type: "HOLD_EXPIRED", metadata: { refundSucceeded } } });
  });

  return true;
}
