import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { handlePaymentIntentSucceeded, handlePaymentIntentFailed } from "@/lib/stripe-webhook-handlers";
import { claimStripeEventForProcessing, markStripeEventProcessed, markStripeEventFailed } from "@/lib/stripe-event-ledger";
import { flagRepeatedProcessingFailure } from "@/lib/payment-reconciliation";

const MAX_ATTEMPTS_BEFORE_FLAGGING = 5;

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const claim = await claimStripeEventForProcessing({
    stripeEventId: event.id,
    type: event.type,
    payload: event as unknown as Prisma.InputJsonValue,
  });

  if (!claim.shouldProcess) {
    // Either already fully processed (true duplicate — no-op) or another
    // in-flight request is handling it right now (not stale yet). Either
    // way, tell Stripe we're done; it should not treat this as a failure.
    return NextResponse.json({ received: true, claimed: false, reason: claim.reason });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      case "charge.refunded":
        // Refund state is authoritatively tracked via our own /api/admin/refunds
        // flow; this case is a placeholder for reconciling refunds initiated
        // directly from the Stripe dashboard.
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(`Stripe webhook processing failed for event ${event.id} (${event.type})`, err);
    await markStripeEventFailed(claim.eventRecordId, err);

    const record = await prisma.stripeEvent.findUnique({ where: { id: claim.eventRecordId } });
    if (record && record.attemptCount >= MAX_ATTEMPTS_BEFORE_FLAGGING) {
      const reservationId =
        event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed"
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

    // Do NOT swallow this and return 200 — a non-2xx response tells
    // Stripe to retry per its own schedule, on top of our own ledger
    // making the next delivery (or a manual replay) retryable rather than
    // a rejected duplicate.
    return NextResponse.json({ error: "Processing failed; will retry." }, { status: 500 });
  }

  await markStripeEventProcessed(claim.eventRecordId);
  return NextResponse.json({ received: true });
}
