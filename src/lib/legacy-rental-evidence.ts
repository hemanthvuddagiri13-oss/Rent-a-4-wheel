import type { FinancialCase, Prisma } from "@prisma/client";
import type Stripe from "stripe";

// Caller holds the reservation lock. Historical reservation cases have no
// links; provider identity must identify existing records, never new operations.
export async function linkLegacyRentalEvidence(tx: Prisma.TransactionClient, c: FinancialCase, intent: Stripe.PaymentIntent) {
  if (!["automatic", "automatic_async"].includes(intent.capture_method) || (intent.metadata.purpose && intent.metadata.purpose !== "rental")) throw new Error("Rental purpose/capture method mismatch");
  const r = await tx.reservation.findUniqueOrThrow({ where: { id: c.reservationId }, include: { customer: true } });
  const customer = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  if (c.customerId !== r.customerId || !r.customer.stripeCustomerId || customer !== r.customer.stripeCustomerId || intent.metadata.reservationId !== r.id) throw new Error("Legacy rental customer/reservation mismatch");
  const ownership = await tx.providerObjectOwnership.findUnique({ where: { providerId: intent.id } });
  if (ownership && (ownership.kind !== "RENTAL" || ownership.reservationId !== r.id || ownership.depositId || ownership.refundId)) throw new Error("Legacy rental provider ownership mismatch");
  const payments = await tx.payment.findMany({ where: { reservationId: r.id, OR: [
    { stripePaymentIntentId: intent.id }, ...(ownership?.paymentId ? [{ id: ownership.paymentId }] : []),
    ...(intent.metadata.paymentId ? [{ id: intent.metadata.paymentId }] : []),
  ] } });
  if (payments.length !== 1) throw new Error("Ambiguous legacy rental payment evidence");
  const payment = payments[0];
  if (payment.type !== "RENTAL" || payment.stripePaymentIntentId !== intent.id || payment.amountCents !== intent.amount || payment.currency !== intent.currency || (c.paymentId && c.paymentId !== payment.id) || (ownership?.paymentId && ownership.paymentId !== payment.id) || (intent.metadata.paymentId && intent.metadata.paymentId !== payment.id)) throw new Error("Legacy rental payment identity/amount mismatch");
  if (payment.status === "SUCCEEDED" && intent.status !== "succeeded") throw new Error("Legacy rental success contradicts provider evidence");
  const operations = await tx.financialOperation.findMany({ where: { reservationId: r.id, kind: "RENTAL", OR: [
    { providerId: intent.id }, ...(ownership?.operationId ? [{ id: ownership.operationId }] : []),
    ...(payment.idempotencyKey ? [{ key: payment.idempotencyKey }] : []),
    ...(intent.metadata.operationKey ? [{ key: intent.metadata.operationKey }] : []),
  ] } });
  if (operations.length !== 1) throw new Error("Ambiguous legacy rental operation evidence");
  const op = operations[0];
  if ((c.providerId && c.providerId !== intent.id) || (c.originalKey && c.originalKey !== op.key)) throw new Error("Legacy case identity mismatch");
  if ((op.providerId && op.providerId !== intent.id) || (c.operationId && c.operationId !== op.id) || (ownership?.operationId && ownership.operationId !== op.id) || (payment.idempotencyKey && payment.idempotencyKey !== op.key) || (intent.metadata.operationKey && intent.metadata.operationKey !== op.key)) throw new Error("Legacy rental operation lineage mismatch");
  if (!op.providerId && intent.metadata.operationKey !== op.key) throw new Error("Missing legacy rental operation lineage");
  // Remaining payload/lease validation is shared with ordinary adoption below.
  // Any rejection rolls this update back, including the existing audit history.
  return tx.financialCase.update({ where: { id: c.id }, data: { paymentId: payment.id, operationId: op.id, providerId: intent.id, originalKey: op.key, amountCents: payment.amountCents, currency: payment.currency } });
}
