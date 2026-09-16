import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import type { Payment, Reservation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { isVehicleAvailable } from "@/lib/availability";
import { refundUnhonorableCharge } from "@/lib/payment-reconciliation";

/** A Stripe-side error that is transient (network blip, Stripe API
 * hiccup) rather than a genuine decline/validation failure. Thrown back
 * up to the caller so the webhook ledger marks the event FAILED and lets
 * Stripe's own retry (plus ours) try again — a temporary failure must
 * never be recorded as a permanent deposit decline. */
function isTransientStripeError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false;
  return (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err.type === "StripeConnectionError" ||
    err.type === "StripeAPIError"
  );
}

type DepositOutcome = "not_required" | "already_succeeded" | "succeeded" | "failed";

async function attemptDepositAuthorization(
  reservation: Reservation & { deposit: { id: string; amountCents: number; status: string } | null },
  intent: Stripe.PaymentIntent
): Promise<{ outcome: DepositOutcome; depositIntentId?: string; failureReason?: string }> {
  if (!reservation.deposit) return { outcome: "not_required" };
  if (reservation.deposit.status === "SUCCEEDED") return { outcome: "already_succeeded" };
  if (reservation.deposit.status !== "REQUIRES_PAYMENT" || !stripe) return { outcome: "not_required" };

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
    return { outcome: "succeeded", depositIntentId: depositIntent.id };
  } catch (err) {
    if (isTransientStripeError(err)) {
      // Don't record a decline for a network/API blip — propagate so the
      // whole event is retried (Stripe's idempotency key on this exact
      // call makes a retry safe: it will not double-authorize).
      throw err;
    }
    const failureReason = err instanceof Error ? err.message : "Deposit authorization failed.";
    console.error("Deposit authorization declined", err);
    return { outcome: "failed", failureReason };
  }
}

/**
 * Persists the outcome of a rental-payment success (plus any deposit
 * authorization attempt) atomically: payment status, deposit status, and
 * the CONFIRMED/DOCUMENTS_REQUIRED or PAYMENT_FAILED transition all
 * commit together or not at all. Database failures are NOT swallowed —
 * they propagate to the caller so the webhook ledger marks the event
 * FAILED (not PROCESSED) and it gets retried; a Stripe-side deposit
 * authorization that already succeeded is safe to retry thanks to its
 * idempotency key.
 */
async function persistPaymentOutcome(params: {
  reservation: Reservation;
  payment: Payment;
  deposit: { id: string; amountCents: number; status: string } | null;
  depositOutcome: DepositOutcome;
  depositIntentId?: string;
  depositFailureReason?: string;
}): Promise<{ confirmed: boolean }> {
  const { reservation, payment, deposit, depositOutcome, depositIntentId, depositFailureReason } = params;
  const shouldConfirm = depositOutcome !== "failed";

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });

    if (deposit) {
      if ((depositOutcome === "succeeded" && depositIntentId) || depositOutcome === "already_succeeded") {
        await tx.securityDeposit.update({
          where: { id: deposit.id },
          data: depositIntentId ? { status: "SUCCEEDED", stripePaymentIntentId: depositIntentId } : { status: "SUCCEEDED" },
        });
      } else if (depositOutcome === "failed") {
        await tx.securityDeposit.update({
          where: { id: deposit.id },
          data: { status: "FAILED", failureReason: depositFailureReason },
        });
      }
    }

    if (shouldConfirm) {
      await transitionReservation(tx, { id: reservation.id, from: reservation.status, to: "CONFIRMED" });
      await transitionReservation(tx, { id: reservation.id, from: "CONFIRMED", to: "DOCUMENTS_REQUIRED" });
      await tx.tripEvent.create({
        data: { reservationId: reservation.id, type: "PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED" },
      });
    } else {
      await transitionReservation(tx, {
        id: reservation.id,
        from: reservation.status,
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

  return { confirmed: shouldConfirm };
}

async function notifyPaymentOutcome(reservation: Reservation, payment: Payment, confirmed: boolean) {
  if (confirmed) {
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

class UnavailableForReconciliationError extends Error {}

/**
 * Handles a rental payment that succeeded after the reservation left
 * AWAITING_PAYMENT (the checkout hold expired mid-payment, an out-of-order
 * cancellation landed first, etc.) — the "customer must not silently lose
 * money" case. If the dates are still genuinely available, the exact same
 * reservation row is narrowly, audibly reopened (not resurrected into a
 * duplicate row) and run through the normal confirm/deposit path under a
 * fresh serializable availability check. If the dates are gone, or the
 * reopen loses a last-instant race, the charge is automatically refunded
 * and a PaymentReconciliation record is left for the case either way.
 */
async function reconcileLatePayment(reservation: Reservation, payment: Payment, intent: Stripe.PaymentIntent) {
  const reopenable = ["EXPIRED", "PAYMENT_FAILED", "CANCELLED_BY_CUSTOMER"].includes(reservation.status);
  const reason = reservation.status === "EXPIRED" ? "PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED" : "PAYMENT_SUCCEEDED_DATES_UNAVAILABLE";

  if (!reopenable) {
    // Reservation is CONFIRMED-or-later already (a genuine out-of-order
    // duplicate success delivery) or in some other state a late payment
    // can't sensibly reopen — nothing to reconcile.
    return;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const stillAvailable = await isVehicleAvailable(reservation.vehicleId, reservation.pickupAt, reservation.returnAt, {
          tx,
          excludeReservationId: reservation.id,
        });
        if (!stillAvailable) throw new UnavailableForReconciliationError();

        // Narrow, explicitly audited exception to the ordinary state
        // machine: only this reconciliation path may reopen a terminal
        // hold, and only immediately before re-running it through the
        // exact same confirm logic every other payment success uses.
        await transitionReservation(tx, {
          id: reservation.id,
          from: reservation.status,
          to: "AWAITING_PAYMENT",
          force: true,
          data: { expiresAt: null },
        });
        await tx.tripEvent.create({
          data: {
            reservationId: reservation.id,
            type: "RECONCILED_LATE_PAYMENT_REOPENED",
            metadata: { previousStatus: reservation.status, reason },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (err) {
    // Only a confirmed "dates are actually taken" outcome — our own
    // pre-check, or the database's own exclusion constraint rejecting the
    // reopen as an overlap — means this charge genuinely can't be
    // honored. Any other failure (a transient DB error, a connection
    // blip) must propagate and be retried, not be mistaken for
    // unavailability and refunded prematurely.
    const isGenuineConflict =
      err instanceof UnavailableForReconciliationError ||
      (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "23P01");
    if (isGenuineConflict) {
      await refundUnhonorableCharge({ reservation, payment, intent, reason });
      return;
    }
    throw err;
  }

  const reopened = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true } });
  const depositResult = await attemptDepositAuthorization(reopened, intent);
  const { confirmed } = await persistPaymentOutcome({
    reservation: reopened,
    payment,
    deposit: reopened.deposit,
    depositOutcome: depositResult.outcome,
    depositIntentId: depositResult.depositIntentId,
    depositFailureReason: depositResult.failureReason,
  });

  await prisma.paymentReconciliation.create({
    data: {
      reservationId: reservation.id,
      paymentId: payment.id,
      stripePaymentIntentId: intent.id,
      reason,
      status: "AUTO_RESOLVED",
      detail: { previousStatus: reservation.status, confirmed },
    },
  });

  await notifyPaymentOutcome(reopened, payment, confirmed);
}

export async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment || payment.type !== "RENTAL" || payment.status === "SUCCEEDED") return;

  const reservation = await prisma.reservation.findUnique({
    where: { id: payment.reservationId },
    include: { deposit: true },
  });
  if (!reservation) return;

  if (reservation.status !== "AWAITING_PAYMENT") {
    await reconcileLatePayment(reservation, payment, intent);
    return;
  }

  const depositResult = await attemptDepositAuthorization(reservation, intent);
  const { confirmed } = await persistPaymentOutcome({
    reservation,
    payment,
    deposit: reservation.deposit,
    depositOutcome: depositResult.outcome,
    depositIntentId: depositResult.depositIntentId,
    depositFailureReason: depositResult.failureReason,
  });

  await notifyPaymentOutcome(reservation, payment, confirmed);
}

export async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) return;

  await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });

  const reservation = await prisma.reservation.findUnique({ where: { id: payment.reservationId } });
  // Out-of-order guard: if the reservation already moved past
  // AWAITING_PAYMENT (e.g. a success event for the same intent was already
  // processed), a late/duplicate failure event must not downgrade it.
  if (!reservation || reservation.status !== "AWAITING_PAYMENT") return;

  await prisma.$transaction(async (tx) => {
    await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "PAYMENT_FAILED" });
    await tx.tripEvent.create({ data: { reservationId: reservation.id, type: "RENTAL_PAYMENT_FAILED" } });
  });
}
