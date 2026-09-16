import type Stripe from "stripe";
import type { Payment, Reservation, SecurityDeposit, Prisma, ReconciliationReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { FULFILLMENT_RECOVERY_STATES, financialProjection } from "@/lib/financial-projection";
import { withReservationLock } from "@/lib/financial-locks";
import { enqueueOutboxNotification } from "@/lib/outbox";
import { isVehicleAvailable } from "@/lib/availability";
import { reserveRefund, executeRefundOperation } from "@/lib/refund-operations";
import { attemptDepositAuthorization, releaseDeposits, handleDepositAuthorizationCanceled } from "@/lib/deposit-authorization";

export async function requireRefund(tx: Prisma.TransactionClient, reservationId: string, payment: Payment, reason: string) {
  const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  if (current.financialDisposition !== "REFUND_REQUIRED" && (current.financialDisposition !== "OPEN" || !FULFILLMENT_RECOVERY_STATES.includes(current.status))) throw new Error("Automatic refund disposition is not authorized");
  await tx.reservation.update({ where: { id: reservationId }, data: { financialDisposition: "REFUND_REQUIRED" } });
  const existing = await tx.refund.findUnique({ where: { idempotencyKey: `terminal-refund:${payment.id}` } });
  if (existing) return existing;
  const refunds = await tx.refund.aggregate({ where: { paymentId: payment.id, status: { in: ["PENDING", "SUCCEEDED"] } }, _sum: { amountCents: true } });
  const remaining = payment.amountCents - (refunds._sum.amountCents ?? 0);
  if (remaining <= 0) return null;
  const refund = await reserveRefund(tx, { reservationId, paymentId: payment.id, idempotencyKey: `terminal-refund:${payment.id}`, amountCents: remaining, reason });
  const reconciliationReason: ReconciliationReason = reason.includes("termination") ? "PAYMENT_SUCCEEDED_AFTER_CANCELLATION" : reason.includes("Dates") ? "PAYMENT_SUCCEEDED_DATES_UNAVAILABLE" : reason.includes("deadline") || reason.includes("window") ? "DEPOSIT_RECOVERY_WINDOW_EXPIRED" : "PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED";
  await tx.paymentReconciliation.create({ data: { reservationId, paymentId: payment.id, stripePaymentIntentId: payment.stripePaymentIntentId,
    reason: reconciliationReason, status: "OPEN", detail: { refundRecordId: refund.id, reason } } });
  return refund;
}

export async function settleTerminatedReservation(id: string) {
  const refunds = await withReservationLock(id, async tx => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { payments: true } });
    if (!["REFUND_REQUIRED", "TERMINATED"].includes(r.financialDisposition)) return null;
    for (const p of r.payments.filter(p => p.type === "RENTAL" && p.status === "SUCCEEDED")) {
      // Normal post-confirmation cancellations remain subject to staff policy.
      if (r.financialDisposition === "REFUND_REQUIRED") await requireRefund(tx, id, p, "Reservation cannot be fulfilled");
    }
    return tx.refund.findMany({ where: { reservationId: id, status: "PENDING" }, include: { payment: true } });
  });
  if (!refunds) return;
  for (const refund of refunds) await executeRefundOperation(refund.id, refund.payment.stripePaymentIntentId);
  if (stripe) await releaseDeposits(id);
}

export async function confirmAfterRentalPaymentSuccess(
  reservation: Reservation & { deposit: SecurityDeposit | null }, payment: Payment, intent: Stripe.PaymentIntent, retry = false
): Promise<{ confirmed: boolean }> {
  const eligible = await withReservationLock(reservation.id, async tx => {
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });
    if (current.financialDisposition === "REFUND_REQUIRED") {
      await requireRefund(tx, current.id, payment, "Payment succeeded after termination");
      return false;
    }
    if (current.financialDisposition !== "OPEN" || !FULFILLMENT_RECOVERY_STATES.includes(current.status)) return false;
    if (current.status === "PAYMENT_FAILED" && current.expiresAt && current.expiresAt <= new Date()) {
      await requireRefund(tx, current.id, payment, "Deposit recovery deadline elapsed");
      await tx.reservation.update({ where: { id: current.id }, data: { status: "EXPIRED", expiresAt: null } });
      return false;
    }
    if (!await isVehicleAvailable(current.vehicleId, current.pickupAt, current.returnAt, { tx, excludeReservationId: current.id })) {
      await requireRefund(tx, current.id, payment, "Dates no longer available");
      await tx.reservation.update({ where: { id: current.id }, data: { status: "EXPIRED", expiresAt: null } });
      return false;
    }
    // Durable inventory ownership before any external deposit call. Never
    // expose an AWAITING_PAYMENT row with a null/expired transient deadline.
    if (current.status === "EXPIRED" || (current.status === "AWAITING_PAYMENT" && current.expiresAt && current.expiresAt <= new Date())) {
      const recorded = await tx.paymentReconciliation.findFirst({ where: { paymentId: payment.id, reason: "PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED" } });
      if (!recorded) await tx.paymentReconciliation.create({ data: { reservationId: current.id, paymentId: payment.id, stripePaymentIntentId: intent.id, reason: "PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED", status: "OPEN" } });
    }
    await tx.reservation.update({ where: { id: current.id }, data: { status: "PAYMENT_FAILED",
      expiresAt: current.status === "PAYMENT_FAILED" && current.expiresAt ? current.expiresAt : new Date(Date.now() + 30 * 60000) } });
    return true;
  });
  if (!eligible) {
    const current = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { payments: true, refunds: true, deposit: true } });
    if (current.financialDisposition !== "OPEN") await settleTerminatedReservation(current.id);
    return { confirmed: financialProjection(current).outcome === "confirmed" };
  }
  await attemptDepositAuthorization(reservation, intent, retry);
  const confirmed = await withReservationLock(reservation.id, async tx => {
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true, payments: true, refunds: true } });
    if (current.financialDisposition !== "OPEN" || current.status !== "PAYMENT_FAILED") return false;
    if (!current.expiresAt || current.expiresAt <= new Date()) {
      await requireRefund(tx, current.id, payment, "Deposit recovery deadline elapsed");
      await tx.reservation.update({ where: { id: current.id }, data: { status: "EXPIRED", expiresAt: null } });
      return false;
    }
    if (!financialProjection(current).financialEligible) {
      await enqueueOutboxNotification(tx, { userId: current.customerId, reservationId: current.id, type: "DEPOSIT_AUTH_FAILED" }, `deposit-recovery:${current.id}`);
      return false;
    }
    await tx.reservation.update({ where: { id: current.id }, data: { status: "DOCUMENTS_REQUIRED", expiresAt: null } });
    await tx.paymentReconciliation.updateMany({ where: { paymentId: payment.id, reason: "PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED", status: "OPEN" }, data: { status: "AUTO_RESOLVED" } });
    await tx.tripEvent.create({ data: { reservationId: current.id, type: "PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED" } });
    await enqueueOutboxNotification(tx, { userId: current.customerId, reservationId: current.id, type: "BOOKING_CONFIRMATION" }, `booking:${current.id}`);
    await enqueueOutboxNotification(tx, { userId: current.customerId, reservationId: current.id, type: "PAYMENT_RECEIPT", extra: { amountCents: payment.amountCents } }, `receipt:${payment.id}`);
    return true;
  });
  if (!confirmed) {
    const current = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    if (current.financialDisposition !== "OPEN") await settleTerminatedReservation(current.id);
  }
  return { confirmed };
}

export async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  if (intent.metadata?.purpose === "security_deposit") return;
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) throw new Error("Payment mapping not yet persisted; retry webhook");
  if (payment.type !== "RENTAL") return;
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: payment.reservationId }, include: { deposit: true } });
  await confirmAfterRentalPaymentSuccess(reservation, payment, intent);
}

export async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment || payment.type !== "RENTAL") return;
  if (payment.status === "SUCCEEDED") return;
  if (!stripe) throw new Error("Stripe unavailable");
  const current = await stripe.paymentIntents.retrieve(intent.id);
  if (current.status === "succeeded") return handlePaymentIntentSucceeded(current);
  await withReservationLock(payment.reservationId, async tx => {
    await tx.payment.updateMany({ where: { id: payment.id, status: { not: "SUCCEEDED" } }, data: { status: "FAILED" } });
    // Rental declines keep the existing bounded checkout window for retry.
    // Only captured-rental deposit recovery owns PAYMENT_FAILED inventory.
  });
}

export async function handlePaymentIntentCanceled(intent: Stripe.PaymentIntent) {
  await handleDepositAuthorizationCanceled(intent);
}
