import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";
import { transitionReservation } from "@/lib/reservation-state-machine";

/**
 * Handles `payment_intent.succeeded` for a RENTAL payment: authorizes the
 * security deposit (if one is required) using the same payment method,
 * and confirms the reservation only if every payment required for
 * confirmation actually succeeded. Extracted from the webhook route so it
 * can be exercised directly in tests without going through HTTP/signature
 * verification (see tests/payments-webhook.test.ts).
 */
export async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment || payment.type !== "RENTAL" || payment.status === "SUCCEEDED") return;

  const reservation = await prisma.reservation.findUnique({
    where: { id: payment.reservationId },
    include: { deposit: true },
  });
  if (!reservation || reservation.status !== "AWAITING_PAYMENT") return;

  let depositOutcome: "not_required" | "succeeded" | "failed" = "not_required";
  let depositIntentId: string | undefined;
  let depositFailureReason: string | undefined;

  if (reservation.deposit?.status === "SUCCEEDED") {
    depositOutcome = "succeeded";
  } else if (reservation.deposit && reservation.deposit.status === "REQUIRES_PAYMENT" && stripe) {
    try {
      const paymentMethodId =
        typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
      const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
      if (!paymentMethodId) throw new Error("No payment method available to authorize the security deposit.");

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
      depositIntentId = depositIntent.id;
      depositOutcome = "succeeded";
    } catch (err) {
      depositOutcome = "failed";
      depositFailureReason = err instanceof Error ? err.message : "Deposit authorization failed.";
      console.error("Deposit authorization failed", err);
    }
  }

  const shouldConfirm = depositOutcome !== "failed";

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });

      if (reservation.deposit) {
        if (depositOutcome === "succeeded" && depositIntentId) {
          await tx.securityDeposit.update({
            where: { id: reservation.deposit.id },
            data: { status: "SUCCEEDED", stripePaymentIntentId: depositIntentId },
          });
        } else if (depositOutcome === "failed") {
          await tx.securityDeposit.update({
            where: { id: reservation.deposit.id },
            data: { status: "FAILED", failureReason: depositFailureReason },
          });
        }
      }

      if (shouldConfirm) {
        await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "CONFIRMED" });
        await transitionReservation(tx, { id: reservation.id, from: "CONFIRMED", to: "DOCUMENTS_REQUIRED" });
        await tx.tripEvent.create({
          data: { reservationId: reservation.id, type: "PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED" },
        });
      } else {
        await transitionReservation(tx, {
          id: reservation.id,
          from: "AWAITING_PAYMENT",
          to: "PAYMENT_FAILED",
          data: { notes: `Deposit authorization failed: ${depositFailureReason}` },
        });
        await tx.tripEvent.create({
          data: {
            reservationId: reservation.id,
            type: "DEPOSIT_AUTHORIZATION_FAILED",
            metadata: { reason: depositFailureReason },
          },
        });
      }
    });
  } catch (err) {
    console.error("Failed to finalize reservation after payment success — requires manual review", err);
    return;
  }

  if (shouldConfirm) {
    await queueNotification({ userId: reservation.customerId, reservationId: reservation.id, type: "BOOKING_CONFIRMATION" });
    await queueNotification({
      userId: reservation.customerId,
      reservationId: reservation.id,
      type: "PAYMENT_RECEIPT",
      extra: { amountCents: payment.amountCents, description: "Rental payment" },
    });
  } else {
    await queueNotification({ userId: reservation.customerId, reservationId: reservation.id, type: "DEPOSIT_AUTH_FAILED" });
  }
}

export async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) return;

  await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });

  const reservation = await prisma.reservation.findUnique({ where: { id: payment.reservationId } });
  if (!reservation || reservation.status !== "AWAITING_PAYMENT") return;

  await prisma.$transaction(async (tx) => {
    await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "PAYMENT_FAILED" });
    await tx.tripEvent.create({ data: { reservationId: reservation.id, type: "RENTAL_PAYMENT_FAILED" } });
  });
}
