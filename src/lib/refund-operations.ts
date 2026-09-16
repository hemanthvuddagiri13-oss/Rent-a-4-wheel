import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import type Stripe from "stripe";
import type { Prisma, Refund } from "@prisma/client";
import { withReservationLock } from "@/lib/financial-locks";
import { prepareOperation, runOperation } from "@/lib/financial-operations";
import { enqueueOutboxNotification } from "@/lib/outbox";

type Request = { idempotencyKey: string; reservationId: string; paymentId: string; amountCents: number; reason?: string; initiatedById?: string };

export async function reserveRefund(tx: Prisma.TransactionClient, params: Request): Promise<Refund> {
  if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) throw new Error("Refund amount must be a positive integer");
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: params.paymentId } });
  if (payment.reservationId !== params.reservationId || payment.status !== "SUCCEEDED" || payment.type !== "RENTAL") throw new Error("Captured rental payment required");
  const existing = await tx.refund.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  if (existing) {
    if (existing.reservationId !== params.reservationId || existing.paymentId !== params.paymentId || existing.amountCents !== params.amountCents || (existing.reason ?? null) !== (params.reason ?? null) || (existing.initiatedById ?? null) !== (params.initiatedById ?? null)) throw new Error("Refund key reused with different parameters");
    return existing;
  }
  const held = await tx.refund.aggregate({ where: { paymentId: payment.id, status: { in: ["PENDING", "SUCCEEDED"] } }, _sum: { amountCents: true } });
  const remaining = payment.amountCents - (held._sum.amountCents ?? 0);
  if (params.amountCents > remaining) throw new Error("Refund exceeds remaining refundable balance");
  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: params.reservationId } });
  const unfinishedTrip = await tx.trip.findFirst({ where: { reservationId: params.reservationId, startedAt: { not: null }, endedAt: null } });
  if (unfinishedTrip) throw new Error("Cannot refund an unfinished trip through this operation");
  if (params.amountCents === remaining) {
    if (["ACTIVE", "RETURN_IN_PROGRESS"].includes(reservation.status)) throw new Error("Cannot fully refund an active trip through this operation");
    await tx.reservation.update({ where: { id: reservation.id }, data: { financialDisposition: "REFUND_REQUIRED" } });
  }
  const refund = await tx.refund.create({ data: { ...params, status: "PENDING" } });
  if (params.initiatedById) await tx.auditLog.create({ data: { actorId: params.initiatedById, action: "reservation.refund.requested", entityType: "Reservation", entityId: params.reservationId, metadata: { refundId: refund.id, amountCents: refund.amountCents } } });
  await prepareOperation(tx, { key: params.idempotencyKey, kind: "REFUND", reservationId: params.reservationId,
    payload: { refundId: refund.id, paymentIntentId: payment.stripePaymentIntentId, amount: refund.amountCents } });
  return refund;
}

export function getOrCreateRefundOperation(params: Request) {
  return withReservationLock(params.reservationId, tx => reserveRefund(tx, params));
}

export type RefundExecutionResult =
  | { status: "SUCCEEDED"; stripeRefundId: string }
  | { status: "FAILED"; error: string }
  | { status: "CANCELLED" }
  | { status: "already_terminal"; refund: Refund };

export async function applyRefundObservation(refundId: string, observed: Stripe.Refund) {
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  return withReservationLock(refund.reservationId, tx => applyRefundObservationTx(tx, refundId, observed));
}

async function applyRefundObservationTx(tx: Prisma.TransactionClient, refundId: string, observed: Stripe.Refund) {
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    const status = observed.status === "succeeded" ? "SUCCEEDED" : observed.status === "failed" ? "FAILED" : observed.status === "canceled" ? "CANCELLED" : "PENDING";
    if (current.status !== "PENDING" && status === "PENDING") return current;
    if (current.status === "SUCCEEDED" && (status === "FAILED" || status === "CANCELLED")) {
      await tx.reservation.update({ where: { id: current.reservationId }, data: { financialDisposition: "REVIEW" } });
    }
    const updated = await tx.refund.update({ where: { id: refundId }, data: { status, stripeRefundId: observed.id, lastError: observed.failure_reason ?? null } });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: current.paymentId } });
    const refunded = await tx.refund.aggregate({ where: { paymentId: payment.id, status: "SUCCEEDED" }, _sum: { amountCents: true } });
    const pending = await tx.refund.count({ where: { paymentId: payment.id, status: "PENDING" } });
    await tx.paymentReconciliation.updateMany({ where: { paymentId: current.paymentId, status: { in: ["OPEN", "NEEDS_MANUAL_REVIEW"] } }, data: {
      status: (refunded._sum.amountCents ?? 0) >= payment.amountCents ? "REFUNDED" : pending > 0 ? "OPEN" : "NEEDS_MANUAL_REVIEW", refundId: observed.id,
    } });
    if (status === "SUCCEEDED") {
      const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: current.reservationId } });
      await enqueueOutboxNotification(tx, { userId: reservation.customerId, reservationId: reservation.id, type: "REFUND", extra: { amountCents: updated.amountCents } }, `refund:${current.id}`);
    }
    return updated;
}

export async function executeRefundOperation(refundId: string, suppliedPaymentIntentId: string | null): Promise<RefundExecutionResult> {
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
  if (refund.payment.stripePaymentIntentId !== suppliedPaymentIntentId) throw new Error("Refund payment mismatch");
  if (refund.status !== "PENDING") return { status: "already_terminal", refund };
  if (!stripe || !refund.payment.stripePaymentIntentId) throw new Error("Stripe refund provider unavailable");
  const client = stripe, intentId = refund.payment.stripePaymentIntentId;
  if (refund.legacyUncertain && !refund.stripeRefundId) throw new Error("Legacy refund outcome requires manual reconciliation");
  const operation = await withReservationLock(refund.reservationId, async tx => {
    const existing = await tx.financialOperation.findUnique({ where: { key: refund.idempotencyKey } });
    if (existing) return existing;
    const created = await prepareOperation(tx, { key: refund.idempotencyKey, kind: "REFUND", reservationId: refund.reservationId,
      payload: { refundId: refund.id, paymentIntentId: intentId, amount: refund.amountCents } });
    // Legacy pending rows may already have reached Stripe before migration.
    // Never grant an old unknown outcome a fresh idempotency replay window.
    return tx.financialOperation.update({ where: { id: created.id }, data: { providerId: refund.stripeRefundId, firstAttemptAt: refund.createdAt } });
  });
  const observed = await runOperation(operation, {
    apply: (tx, result) => applyRefundObservationTx(tx, refund.id, result),
    create: key => client.refunds.create({ payment_intent: intentId, amount: refund.amountCents, reason: "requested_by_customer", metadata: { operationKey: key, refundId: refund.id } }, { idempotencyKey: key }),
    retrieve: id => client.refunds.retrieve(id),
    discover: async () => {
      for await (const item of client.refunds.list({ payment_intent: intentId, limit: 100 })) if (item.metadata?.operationKey === operation.key) return item;
      return null;
    },
  });
  const updated = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  if (updated.status === "SUCCEEDED") return { status: "SUCCEEDED", stripeRefundId: observed.id };
  if (updated.status === "FAILED") return { status: "FAILED", error: updated.lastError ?? "Provider rejected refund" };
  if (updated.status === "CANCELLED") return { status: "CANCELLED" };
  return { status: "already_terminal", refund: updated };
}

export async function reconcileRefundStatus(stripeRefundId: string, _stripeStatus: string): Promise<void> {
  void _stripeStatus; // Event payload order is not authoritative; always retrieve.
  if (!stripe) throw new Error("Stripe unavailable");
  const observed = await stripe.refunds.retrieve(stripeRefundId);
  let refund = await prisma.refund.findUnique({ where: { stripeRefundId } });
  if (!refund && observed.metadata?.refundId) refund = await prisma.refund.findUnique({ where: { id: observed.metadata.refundId } });
  if (!refund) {
    const intentId = typeof observed.payment_intent === "string" ? observed.payment_intent : observed.payment_intent?.id;
    const payment = intentId ? await prisma.payment.findUnique({ where: { stripePaymentIntentId: intentId } }) : null;
    if (!payment) throw new Error("Refund payment not yet known; retry event");
    refund = await withReservationLock(payment.reservationId, async tx => {
      await tx.reservation.update({ where: { id: payment.reservationId }, data: { financialDisposition: "REVIEW" } });
      return tx.refund.upsert({ where: { stripeRefundId }, update: {}, create: { reservationId: payment.reservationId, paymentId: payment.id, amountCents: observed.amount, idempotencyKey: `external:${stripeRefundId}`, stripeRefundId, status: "PENDING" } });
    });
  }
  await applyRefundObservation(refund.id, observed);
}
