import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";

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

async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) return;

  await prisma.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });

  const reservation = await prisma.reservation.findUnique({
    where: { id: payment.reservationId },
    include: { deposit: true },
  });
  if (!reservation) return;

  if (payment.type === "RENTAL" && reservation.status === "PENDING") {
    await prisma.reservation.update({ where: { id: reservation.id }, data: { status: "CONFIRMED" } });
    await queueNotification({ userId: reservation.customerId, reservationId: reservation.id, type: "BOOKING_CONFIRMATION" });
    await queueNotification({
      userId: reservation.customerId,
      reservationId: reservation.id,
      type: "PAYMENT_RECEIPT",
      extra: { amountCents: payment.amountCents, description: "Rental payment" },
    });

    // Authorize the security deposit (manual capture hold) using the same
    // payment method the customer just used, so they aren't asked to enter
    // card details twice. If off-session confirmation fails (e.g. the
    // issuer requires additional authentication), the deposit is left
    // REQUIRES_PAYMENT for staff to collect manually at pickup.
    if (reservation.deposit && reservation.deposit.status === "REQUIRES_PAYMENT" && stripe) {
      try {
        const paymentMethodId =
          typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
        const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;

        if (paymentMethodId) {
          const depositIntent = await stripe.paymentIntents.create(
            {
              amount: reservation.deposit.amountCents,
              currency: "usd",
              customer: customerId,
              payment_method: paymentMethodId,
              capture_method: "manual",
              confirm: true,
              off_session: true,
              metadata: { reservationId: reservation.id, purpose: "security_deposit" },
            },
            { idempotencyKey: `deposit-${reservation.id}` }
          );

          await prisma.securityDeposit.update({
            where: { id: reservation.deposit.id },
            data: { stripePaymentIntentId: depositIntent.id, status: "SUCCEEDED" },
          });
        }
      } catch (err) {
        console.error("Deposit authorization failed — will require manual collection at pickup", err);
      }
    }
  }
}

async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) return;
  await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
}
