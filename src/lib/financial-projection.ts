import type { FinancialOperation, Payment, Refund, Reservation, SecurityDeposit } from "@prisma/client";

export const FULFILLMENT_RECOVERY_STATES = ["CHECKOUT_HOLD", "AWAITING_PAYMENT", "PAYMENT_FAILED", "EXPIRED"];
export const PRE_TRIP_STATES = ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"];
type FinancialSnapshot = Pick<Reservation, "status" | "financialDisposition" | "depositCents"> & {
  payments: Payment[]; refunds: Refund[]; deposit: (SecurityDeposit & { operation?: FinancialOperation | null }) | null;
};

// Shared by API/UI confirmation, fulfillment, and the locked trip-start gate.
export function financialProjection(r: FinancialSnapshot, now = new Date()) {
  const captured = r.payments.filter(p => p.type === "RENTAL" && p.status === "SUCCEEDED");
  const paidCents = captured.reduce((n, p) => n + p.amountCents, 0);
  const refunds = r.refunds.filter(f => captured.some(p => p.id === f.paymentId));
  const refundedCents = refunds.filter(f => f.status === "SUCCEEDED").reduce((n, f) => n + f.amountCents, 0);
  const pendingRefundCents = refunds.filter(f => (f.status === "PENDING" || f.legacyUncertain)).reduce((n, f) => n + f.amountCents, 0);
  const refundStatus = pendingRefundCents > 0 ? "pending" : refunds.some(f => ["FAILED", "CANCELLED"].includes(f.status)) ? "failed" : paidCents > 0 && refundedCents >= paidCents ? "refunded" : refundedCents > 0 ? "partial" : "none";
  const d = r.deposit;
  const depositValid = r.depositCents === 0 || Boolean(d && !d.legacyUncertain && d.operation && d.operationId === d.operation.id && d.operation.kind === "DEPOSIT" && d.operation.generation === d.generation && d.generation > 0 && d.operation.providerId === d.stripePaymentIntentId && !["REVIEW", "DEAD_LETTER"].includes(d.operation.state) && d.capturableAmountCents >= r.depositCents && d.status === "SUCCEEDED" && d.stripeStatus === "requires_capture" && d.amountCents >= r.depositCents && d.authorizationExpiresAt && d.authorizationExpiresAt > now && !d.releasedAt);
  const moneyAvailable = paidCents > refundedCents + pendingRefundCents;
  const financialEligible = r.financialDisposition === "OPEN" && moneyAvailable && depositValid;
  let outcome = "processing";
  if (paidCents > 0 && refundedCents >= paidCents) outcome = "refunded";
  else if (paidCents > 0 && pendingRefundCents > 0) outcome = "refund_pending";
  else if (refundStatus === "failed") outcome = "refund_failed";
  else if (r.financialDisposition === "REVIEW") outcome = "review_required";
  else if (["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"].includes(r.status)) outcome = "cancelled";
  else if (r.status === "EXPIRED") outcome = "expired";
  else if (r.financialDisposition !== "OPEN") outcome = "review_required";
  else if (d?.stripeStatus === "requires_action" && r.depositCents > 0) outcome = "deposit_action_required";
  else if (financialEligible && [...PRE_TRIP_STATES, "ACTIVE"].includes(r.status)) outcome = "confirmed";
  else if (r.status === "PAYMENT_FAILED" || (paidCents > 0 && !depositValid)) outcome = "payment_failed";
  return { outcome, paidCents, refundedCents, pendingRefundCents, refundStatus, depositValid, moneyAvailable, financialEligible,
    rentalPaymentStatus: captured.length ? "SUCCEEDED" : r.payments.find(p => p.type === "RENTAL")?.status ?? null,
    depositStatus: d?.stripeStatus ?? null };
}
