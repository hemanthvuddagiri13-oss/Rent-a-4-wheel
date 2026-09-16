import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";
import type { Payment, Reservation, ReconciliationReason } from "@prisma/client";

/**
 * Automatically refunds a rental payment that succeeded but cannot be
 * turned into a valid reservation (the hold expired and someone else took
 * the dates, or the dates are otherwise no longer available), and leaves
 * an explicit, permanent PaymentReconciliation record either way — a
 * successful Stripe refund closes the case (REFUNDED); a failed refund
 * attempt is flagged NEEDS_MANUAL_REVIEW rather than silently retried
 * forever, since refund failures need a human, not a robot, to resolve.
 */
export async function refundUnhonorableCharge(params: {
  reservation: Reservation;
  payment: Payment;
  intent: Stripe.PaymentIntent;
  reason: ReconciliationReason;
}): Promise<void> {
  const { reservation, payment, intent, reason } = params;

  let refundId: string | undefined;
  let refundError: string | undefined;

  if (stripe) {
    try {
      const refund = await stripe.refunds.create(
        { payment_intent: intent.id, reason: "requested_by_customer" },
        { idempotencyKey: `refund-unhonorable-${intent.id}` }
      );
      refundId = refund.id;
    } catch (err) {
      refundError = err instanceof Error ? err.message : "Refund attempt failed.";
      console.error("Automatic refund failed for an unhonorable charge — needs manual review", err);
    }
  } else {
    refundError = "Stripe client unavailable when attempting automatic refund.";
  }

  await prisma.$transaction(async (tx) => {
    if (refundId) {
      await tx.refund.create({
        data: {
          reservationId: reservation.id,
          paymentId: payment.id,
          amountCents: payment.amountCents,
          reason: `Automatic refund: ${reason}`,
          status: "SUCCEEDED",
          stripeRefundId: refundId,
        },
      });
    }

    await tx.paymentReconciliation.create({
      data: {
        reservationId: reservation.id,
        paymentId: payment.id,
        stripePaymentIntentId: intent.id,
        reason,
        status: refundId ? "REFUNDED" : "NEEDS_MANUAL_REVIEW",
        refundId,
        detail: { refundError, reservationStatusAtReconciliation: reservation.status },
      },
    });

    await tx.tripEvent.create({
      data: {
        reservationId: reservation.id,
        type: refundId ? "PAYMENT_RECONCILED_REFUNDED" : "PAYMENT_RECONCILIATION_NEEDS_REVIEW",
        metadata: { reason, refundId, refundError },
      },
    });
  });

  if (refundId) {
    await queueNotification({
      userId: reservation.customerId,
      reservationId: reservation.id,
      type: "REFUND",
      extra: { amountCents: payment.amountCents },
    });
  }
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
  const existing = await prisma.paymentReconciliation.findFirst({
    where: { reason: "WEBHOOK_PROCESSING_REPEATEDLY_FAILED", detail: { path: ["stripeEventId"], equals: params.stripeEventId } },
  });
  if (existing) return; // already flagged for this event

  await prisma.paymentReconciliation.create({
    data: {
      reservationId: params.reservationId,
      reason: "WEBHOOK_PROCESSING_REPEATEDLY_FAILED",
      status: "NEEDS_MANUAL_REVIEW",
      detail: { stripeEventId: params.stripeEventId, attemptCount: params.attemptCount, lastError: params.lastError },
    },
  });
}
