import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { handlePaymentIntentSucceeded, handlePaymentIntentFailed } from "@/lib/stripe-webhook-handlers";

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

  // Idempotency ledger: claim this exact Stripe event ID before any side
  // effect runs. A duplicate delivery (retry, or a second webhook endpoint
  // receiving the same event) hits the unique constraint and is a no-op —
  // Stripe always gets a 200 either way so it stops retrying.
  try {
    await prisma.stripeEvent.create({
      data: { stripeEventId: event.id, type: event.type, payload: event as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    throw err;
  }

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

  return NextResponse.json({ received: true });
}
