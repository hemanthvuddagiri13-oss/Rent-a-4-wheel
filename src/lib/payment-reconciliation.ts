import { prisma } from "@/lib/prisma";
import { lockReservation, withReservationLock } from "@/lib/financial-locks";
import { requireRefund, settleTerminatedReservation } from "@/lib/stripe-webhook-handlers";
import type { Payment, Reservation, ReconciliationReason } from "@prisma/client";

/**
 * Automatically refunds a rental payment that succeeded but cannot (or,
 * per policy, must not — e.g. a cancellation) be turned into an active
 * reservation, and leaves an explicit, permanent PaymentReconciliation
 * record either way. Uses the idempotent Refund-operation primitive
 * (src/lib/refund-operations.ts): a durable, deterministically-keyed
 * refund row is created before Stripe is ever called, so a crash between
 * a successful Stripe refund and this function recording that success is
 * safe to retry — the retry resumes the same row rather than issuing a
 * second refund. A successful refund closes the case (REFUNDED); a
 * failed refund attempt is flagged NEEDS_MANUAL_REVIEW rather than
 * retried forever, since refund failures need a human, not a robot, to
 * resolve.
 */
export async function refundUnhonorableCharge(params: {
  reservation: Reservation;
  payment: Payment;
  stripePaymentIntentId: string;
  reason: ReconciliationReason;
  idempotencyKeySuffix: string;
}): Promise<void> {
  await withReservationLock(params.reservation.id, async tx => {
    await tx.payment.update({ where: { id: params.payment.id }, data: { status: "SUCCEEDED" } });
    await requireRefund(tx, params.reservation.id, params.payment, params.reason);
  });
  await settleTerminatedReservation(params.reservation.id);
}

/**
 * Safety-net visibility for a webhook event that has failed processing
 * repeatedly (e.g. a sustained DB outage striking right after a
 * successful Stripe-side deposit authorization). Retries continue
 * regardless — Stripe's own idempotency key on the deposit call makes
 * retrying safe — but ops should not have to wait for Stripe's ~3-day
 * retry window to run out before finding out something is stuck.
 */
export async function flagRepeatedProcessingFailure(params: {
  reservationId?: string;
  stripeEventId: string;
  attemptCount: number;
  lastError: string;
}): Promise<void> {
  await prisma.$transaction(async tx => {
  if (params.reservationId) await lockReservation(tx,params.reservationId);
  const existing = await tx.paymentReconciliation.findFirst({
    where: { reason: "WEBHOOK_PROCESSING_REPEATEDLY_FAILED", detail: { path: ["stripeEventId"], equals: params.stripeEventId } },
  });
  if (existing) return; // already flagged for this event

  await tx.paymentReconciliation.create({
    data: {
      reservationId: params.reservationId,
      reason: "WEBHOOK_PROCESSING_REPEATEDLY_FAILED",
      status: "NEEDS_MANUAL_REVIEW",
      detail: { stripeEventId: params.stripeEventId, attemptCount: params.attemptCount, lastError: params.lastError },
    },
  });
  });
}
