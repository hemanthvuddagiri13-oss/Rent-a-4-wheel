import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import type { Refund } from "@prisma/client";

/**
 * The durable, idempotent refund primitive used by BOTH staff-initiated
 * refunds (admin action) and system-initiated reconciliation refunds
 * (src/lib/payment-reconciliation.ts). A `Refund` row is created in
 * PENDING status — keyed by a caller-supplied deterministic
 * `idempotencyKey` — BEFORE Stripe is ever called. Creating the row is
 * NOT completion: only `status: SUCCEEDED` is. Any retry/replay (a crash
 * between a successful Stripe call and this row being updated, a
 * duplicate staff click, a reconciliation re-run) looks up the existing
 * row by `idempotencyKey` first and resumes it rather than calling Stripe
 * again from scratch.
 */
export async function getOrCreateRefundOperation(params: {
  idempotencyKey: string;
  reservationId: string;
  paymentId: string;
  amountCents: number;
  reason?: string;
  initiatedById?: string;
}): Promise<Refund> {
  const existing = await prisma.refund.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  if (existing) return existing;

  try {
    return await prisma.refund.create({
      data: {
        reservationId: params.reservationId,
        paymentId: params.paymentId,
        amountCents: params.amountCents,
        reason: params.reason,
        status: "PENDING",
        idempotencyKey: params.idempotencyKey,
        initiatedById: params.initiatedById,
      },
    });
  } catch {
    // Lost a create race to a concurrent caller with the same
    // idempotencyKey — fetch what they created.
    return prisma.refund.findUniqueOrThrow({ where: { idempotencyKey: params.idempotencyKey } });
  }
}

export type RefundExecutionResult =
  | { status: "SUCCEEDED"; stripeRefundId: string }
  | { status: "FAILED"; error: string }
  | { status: "CANCELLED" }
  | { status: "already_terminal"; refund: Refund };

/**
 * Executes (or resumes) a refund operation. Safe to call repeatedly for
 * the same `refundId` — a row already in a terminal state (SUCCEEDED,
 * FAILED, CANCELLED) is returned as-is without calling Stripe again. A
 * PENDING row calls Stripe with the row's OWN `idempotencyKey` passed
 * through as Stripe's idempotency key too, so even a crash between a
 * successful Stripe call and this function persisting that success is
 * safe to retry — Stripe returns the original refund object instead of
 * creating a second one.
 */
export async function executeRefundOperation(refundId: string, stripePaymentIntentId: string | null): Promise<RefundExecutionResult> {
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status !== "PENDING") {
    return { status: "already_terminal", refund };
  }

  if (!stripe || !stripePaymentIntentId) {
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: "FAILED", lastError: "Stripe is not configured or no payment intent is associated." },
    });
    return { status: "FAILED", error: "Stripe is not configured or no payment intent is associated." };
  }

  try {
    const stripeRefund = await stripe.refunds.create(
      { payment_intent: stripePaymentIntentId, amount: refund.amountCents, reason: "requested_by_customer" },
      { idempotencyKey: refund.idempotencyKey }
    );

    // Stripe refunds can themselves be asynchronous (e.g. certain bank
    // debit sources) — only treat it as SUCCEEDED here if Stripe already
    // reports it as such; otherwise it stays PENDING and a later
    // `charge.refund.updated` webhook (see reconcileRefundStatus) resolves it.
    if (stripeRefund.status === "succeeded") {
      await prisma.refund.update({
        where: { id: refundId },
        data: { status: "SUCCEEDED", stripeRefundId: stripeRefund.id },
      });
      return { status: "SUCCEEDED", stripeRefundId: stripeRefund.id };
    }

    await prisma.refund.update({ where: { id: refundId }, data: { stripeRefundId: stripeRefund.id } });
    return { status: "already_terminal", refund: { ...refund, stripeRefundId: stripeRefund.id } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refund attempt failed.";
    await prisma.refund.update({ where: { id: refundId }, data: { status: "FAILED", lastError: message } });
    return { status: "FAILED", error: message };
  }
}

/**
 * Applies a Stripe `charge.refund.updated` (or equivalent) event to our
 * durable Refund row, by Stripe refund ID — handles the
 * PENDING -> SUCCEEDED/FAILED transition for refunds that resolve
 * asynchronously after creation. Monotonic: never moves a row already in
 * a terminal state backwards.
 */
export async function reconcileRefundStatus(stripeRefundId: string, stripeStatus: string): Promise<void> {
  const refund = await prisma.refund.findUnique({ where: { stripeRefundId } });
  if (!refund) return;
  if (refund.status !== "PENDING") return; // already terminal — monotonic, do not reverse

  const nextStatus = stripeStatus === "succeeded" ? "SUCCEEDED" : stripeStatus === "failed" ? "FAILED" : stripeStatus === "canceled" ? "CANCELLED" : null;
  if (!nextStatus) return;

  await prisma.refund.update({ where: { id: refund.id }, data: { status: nextStatus } });
}
