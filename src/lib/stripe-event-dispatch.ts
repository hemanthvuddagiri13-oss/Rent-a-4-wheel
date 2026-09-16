import { safeLog } from "@/lib/safe-log";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { markStripeEventProcessed, markStripeEventFailed } from "@/lib/stripe-event-ledger";
import { flagRepeatedProcessingFailure } from "@/lib/payment-reconciliation";
import {
  handlePaymentIntentSucceeded,
  handlePaymentIntentFailed,
  handlePaymentIntentCanceled,
} from "@/lib/stripe-webhook-handlers";
import { reconcileRefundStatus } from "@/lib/refund-operations";
import { eventFence } from "@/lib/financial-locks";
import { stripe } from "@/lib/stripe";

const MAX_ATTEMPTS_BEFORE_FLAGGING = 5;

/**
 * Dispatches one already-claimed Stripe event to its handler and settles
 * the ledger row (PROCESSED on success, FAILED — with the fencing token —
 * on failure). Shared by the live webhook route and the scheduled
 * recovery worker (/api/cron/reconcile-stripe-events) so both paths
 * settle events identically.
 *
 * Returns `false` (never throws) on failure — callers decide what HTTP
 * status/response that implies; the ledger itself is always left in a
 * consistent state either way.
 */
export async function dispatchClaimedStripeEvent(params: {
  eventRecordId: string;
  leaseToken: string;
  event: Stripe.Event;
}): Promise<{ ok: boolean }> {
  return eventFence.run({ id: params.eventRecordId, token: params.leaseToken }, () => dispatchWithFence(params));
}

async function dispatchWithFence(params: { eventRecordId: string; leaseToken: string; event: Stripe.Event }): Promise<{ ok: boolean }> {
  const { eventRecordId, leaseToken, event } = params;

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.canceled":
        await handlePaymentIntentCanceled(event.data.object as Stripe.PaymentIntent);
        break;
      case "charge.refund.updated":
      case "refund.created":
      case "refund.failed":
      case "refund.updated": {
        const refundObject = event.data.object as Stripe.Refund;
        await reconcileRefundStatus(refundObject.id, refundObject.status ?? "");
        break;
      }
      case "charge.refunded":
        if (!stripe) throw new Error("Stripe unavailable");
        for await (const refund of stripe.refunds.list({ charge: (event.data.object as Stripe.Charge).id, limit: 100 })) {
          await reconcileRefundStatus(refund.id, refund.status ?? "");
        }
        break;
      default:
        break;
    }
  } catch (err) {
    safeLog("WEBHOOK_FAILED", err, event.id);
    await markStripeEventFailed(eventRecordId, leaseToken, err);

    const record = await prisma.stripeEvent.findUnique({ where: { id: eventRecordId } });
    if (record && record.attemptCount >= MAX_ATTEMPTS_BEFORE_FLAGGING) {
      const reservationId =
        event.type === "payment_intent.succeeded" ||
        event.type === "payment_intent.payment_failed" ||
        event.type === "payment_intent.canceled"
          ? (
              await prisma.payment.findUnique({
                where: { stripePaymentIntentId: (event.data.object as Stripe.PaymentIntent).id },
                select: { reservationId: true },
              })
            )?.reservationId
          : undefined;
      await flagRepeatedProcessingFailure({
        reservationId,
        stripeEventId: event.id,
        attemptCount: record.attemptCount,
        lastError: record.lastError ?? "unknown error",
      });
    }
    return { ok: false };
  }

  await markStripeEventProcessed(eventRecordId, leaseToken);
  return { ok: true };
}
