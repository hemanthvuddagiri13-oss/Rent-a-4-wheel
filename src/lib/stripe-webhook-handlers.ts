import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import type { Payment, Reservation, SecurityDeposit } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { enqueueOutboxNotification } from "@/lib/outbox";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { isVehicleAvailable } from "@/lib/availability";
import { refundUnhonorableCharge } from "@/lib/payment-reconciliation";
import { attemptDepositAuthorization, handleDepositAuthorizationCanceled } from "@/lib/deposit-authorization";

// How long a customer has to resolve a failed deposit authorization
// (retry with a different payment method) before we automatically refund
// the rental payment we're still holding and release the vehicle — see
// src/lib/cleanup.ts.
const DEPOSIT_RECOVERY_WINDOW_MINUTES = 30;

function computeRecoveryDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEPOSIT_RECOVERY_WINDOW_MINUTES * 60 * 1000);
}

class UnavailableForReconciliationError extends Error {}

type ReservationWithDeposit = Reservation & { deposit: SecurityDeposit | null };

/**
 * Runs the deposit-authorization attempt plus the atomic persist step
 * shared by both the ordinary (still-within-window) success path and the
 * late-payment reconciliation path once a reservation has been narrowly
 * reopened. Propagates transient Stripe errors (network/API/rate-limit)
 * so the caller's ledger retry mechanism handles them — it must NEVER
 * record those as a permanent deposit decline.
 */
export async function confirmAfterRentalPaymentSuccess(
  reservation: ReservationWithDeposit,
  payment: Payment,
  intent: Stripe.PaymentIntent
): Promise<{ confirmed: boolean }> {
  const depositResult = await attemptDepositAuthorization(reservation, intent);
  const shouldConfirm = depositResult.outcome !== "failed";

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });

    if (reservation.deposit) {
      if (depositResult.outcome === "succeeded") {
        await tx.securityDeposit.update({
          where: { id: reservation.deposit.id },
          data: {
            status: "SUCCEEDED",
            stripePaymentIntentId: depositResult.depositIntentId,
            stripeStatus: "requires_capture",
            authorizedAt: depositResult.authorizedAt,
            authorizationExpiresAt: depositResult.authorizationExpiresAt,
            failureReason: null,
          },
        });
      } else if (depositResult.outcome === "failed") {
        await tx.securityDeposit.update({
          where: { id: reservation.deposit.id },
          data: { status: "FAILED", failureReason: depositResult.failureReason },
        });
      }
      // "already_valid" / "not_required": nothing to change.
    }

    if (shouldConfirm) {
      await transitionReservation(tx, { id: reservation.id, from: reservation.status, to: "CONFIRMED" });
      await transitionReservation(tx, { id: reservation.id, from: "CONFIRMED", to: "DOCUMENTS_REQUIRED" });
      await tx.tripEvent.create({
        data: { reservationId: reservation.id, type: "PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED" },
      });
      await enqueueOutboxNotification(tx, { userId: reservation.customerId, reservationId: reservation.id, type: "BOOKING_CONFIRMATION" });
      await enqueueOutboxNotification(tx, {
        userId: reservation.customerId,
        reservationId: reservation.id,
        type: "PAYMENT_RECEIPT",
        extra: { amountCents: payment.amountCents, description: "Rental payment" },
      });
    } else {
      // Never release inventory while silently retaining the rental
      // payment: PAYMENT_FAILED is a durable-blocking status (see
      // reservation-state-machine.ts) — the vehicle stays held — with its
      // own recovery-deadline `expiresAt` that the cleanup job uses to
      // decide when to automatically refund and finally release it.
      await transitionReservation(tx, {
        id: reservation.id,
        from: reservation.status,
        to: "PAYMENT_FAILED",
        data: {
          notes: `Deposit authorization failed: ${depositResult.outcome === "failed" ? depositResult.failureReason : "unknown"}`,
          expiresAt: computeRecoveryDeadline(),
        },
      });
      await tx.tripEvent.create({
        data: {
          reservationId: reservation.id,
          type: "DEPOSIT_AUTHORIZATION_FAILED",
          metadata: { reason: depositResult.outcome === "failed" ? depositResult.failureReason : undefined },
        },
      });
      await enqueueOutboxNotification(tx, { userId: reservation.customerId, reservationId: reservation.id, type: "DEPOSIT_AUTH_FAILED" });
    }
  });

  return { confirmed: shouldConfirm };
}

/**
 * Handles a rental payment that succeeded once the reservation is no
 * longer cleanly within its AWAITING_PAYMENT window — either because its
 * status already moved on (EXPIRED, PAYMENT_FAILED, a cancellation) or
 * because it is still nominally AWAITING_PAYMENT but its `expiresAt` has
 * already passed and the cleanup job simply hasn't run yet (item 3: a
 * late payment must enter this path regardless of whether the status has
 * caught up).
 *
 * A cancellation (customer- or host-initiated) is NEVER reversed by a
 * late payment, full stop — it always goes straight to refund/escalate.
 * An expired hold or a lapsed deposit-recovery window MAY be narrowly
 * reopened (this exact reservation, not a duplicate) if the dates are
 * still genuinely available under a fresh serializable check; otherwise
 * the charge is automatically refunded with an explicit review record.
 */
async function reconcileLatePayment(reservation: Reservation, payment: Payment, intent: Stripe.PaymentIntent): Promise<void> {
  const now = new Date();

  if (reservation.status === "CANCELLED_BY_CUSTOMER" || reservation.status === "CANCELLED_BY_HOST") {
    await refundUnhonorableCharge({
      reservation,
      payment,
      stripePaymentIntentId: intent.id,
      reason: "PAYMENT_SUCCEEDED_AFTER_CANCELLATION",
      idempotencyKeySuffix: "late-cancel",
    });
    return;
  }

  const isExpiredHold = reservation.status === "EXPIRED";
  const isFailedRecovery = reservation.status === "PAYMENT_FAILED";
  const isStillAwaitingButPastDeadline =
    reservation.status === "AWAITING_PAYMENT" && reservation.expiresAt !== null && reservation.expiresAt < now;

  if (!isExpiredHold && !isFailedRecovery && !isStillAwaitingButPastDeadline) {
    // Already CONFIRMED-or-later, DISPUTED, etc. — a duplicate/out-of-order
    // delivery for an already-settled reservation. Nothing to reconcile.
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
        // hold or a lapsed recovery window, and only immediately before
        // re-running it through the exact same confirm logic every other
        // payment success uses.
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
            metadata: { previousStatus: reservation.status },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (err) {
    const isGenuineConflict =
      err instanceof UnavailableForReconciliationError ||
      (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "23P01");
    if (isGenuineConflict) {
      await refundUnhonorableCharge({
        reservation,
        payment,
        stripePaymentIntentId: intent.id,
        reason: "PAYMENT_SUCCEEDED_DATES_UNAVAILABLE",
        idempotencyKeySuffix: "late-unavailable",
      });
      return;
    }
    throw err;
  }

  const reopened = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true } });
  const { confirmed } = await confirmAfterRentalPaymentSuccess(reopened, payment, intent);

  await prisma.paymentReconciliation.create({
    data: {
      reservationId: reservation.id,
      paymentId: payment.id,
      stripePaymentIntentId: intent.id,
      reason: "PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED",
      status: "AUTO_RESOLVED",
      detail: { previousStatus: reservation.status, confirmed },
    },
  });
}

export async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment || payment.type !== "RENTAL") return;
  // Monotonic guard: a payment already recorded SUCCEEDED never changes —
  // this also makes re-delivery of this same event a safe no-op.
  if (payment.status === "SUCCEEDED") return;

  const reservation = await prisma.reservation.findUnique({
    where: { id: payment.reservationId },
    include: { deposit: true },
  });
  if (!reservation) return;

  const now = new Date();
  const isLate = reservation.status !== "AWAITING_PAYMENT" || (reservation.expiresAt !== null && reservation.expiresAt < now);

  if (isLate) {
    await reconcileLatePayment(reservation, payment, intent);
    return;
  }

  await confirmAfterRentalPaymentSuccess(reservation, payment, intent);
}

export async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) return;
  // Monotonic guard: never let a failure event downgrade a payment we've
  // already recorded as SUCCEEDED.
  if (payment.status === "SUCCEEDED") return;

  // Reconcile against Stripe's own authoritative current state rather
  // than blindly trusting this event's delivery order — a
  // payment_intent.payment_failed can arrive after a success (Stripe does
  // not guarantee webhook ordering). If Stripe now reports the intent as
  // succeeded, self-heal by routing to the success handler instead of
  // silently doing nothing (which would leave the reservation stuck).
  if (stripe) {
    try {
      const authoritative = await stripe.paymentIntents.retrieve(intent.id);
      if (authoritative.status === "succeeded") {
        await handlePaymentIntentSucceeded(authoritative);
        return;
      }
    } catch (err) {
      console.error("Failed to fetch authoritative PaymentIntent state during failure reconciliation", err);
    }
  }

  await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });

  const reservation = await prisma.reservation.findUnique({ where: { id: payment.reservationId } });
  if (!reservation || reservation.status !== "AWAITING_PAYMENT") return;

  await prisma.$transaction(async (tx) => {
    await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "PAYMENT_FAILED" });
    await tx.tripEvent.create({ data: { reservationId: reservation.id, type: "RENTAL_PAYMENT_FAILED" } });
  });
}

/** Handles Stripe auto-releasing (or an explicit cancel of) an uncaptured
 * deposit authorization. Rental-purpose PaymentIntents reaching
 * `canceled` (e.g. an abandoned checkout before confirmation) have
 * nothing further to reconcile here. */
export async function handlePaymentIntentCanceled(intent: Stripe.PaymentIntent): Promise<void> {
  await handleDepositAuthorizationCanceled(intent);
}
