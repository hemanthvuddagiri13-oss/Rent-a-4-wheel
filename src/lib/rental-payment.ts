import { freezeFinance } from "@/lib/finance-rules";
import type Stripe from "stripe";
import type { FinancialOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe, ensureStripeCustomer } from "@/lib/stripe";
import { withReservationLock } from "@/lib/financial-locks";
import { json, prepareOperation, runOperation } from "@/lib/financial-operations";

export async function createRentalPayment(reservationId: string, customerId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
  const customer = await ensureStripeCustomer(user);
  const operation = await withReservationLock(reservationId, async tx => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    if (r.customerId !== customerId || r.financialDisposition !== "OPEN" || r.status !== "AWAITING_PAYMENT" || !r.expiresAt || r.expiresAt <= new Date()) throw new Error("Checkout is no longer payable");
    await freezeFinance(tx,reservationId);
    const payment = await tx.payment.upsert({ where: { idempotencyKey: `rental-${r.id}` }, update: {}, create: { reservationId: r.id, type: "RENTAL", amountCents: r.totalCents, idempotencyKey: `rental-${r.id}` } });
    const existing = await tx.financialOperation.findUnique({ where: { key: `rental-${r.id}` } });
    if (existing) return existing;
    const op = await prepareOperation(tx, { key: `rental-${r.id}`, kind: "RENTAL", reservationId: r.id, payload: json({
      amount: payment.amountCents, currency: payment.currency, customer, payment_method_types: ["card"],
      setup_future_usage: r.depositCents > 0 ? "off_session" : undefined,
      metadata: { reservationId: r.id, paymentId: payment.id, confirmationNumber: r.confirmationNumber },
    }) });
    // Existing pre-migration intents must be retrieved, never recreated.
    if (payment.stripePaymentIntentId) return tx.financialOperation.update({ where: { id: op.id }, data: { providerId: payment.stripePaymentIntentId, firstAttemptAt: payment.createdAt } });
    return op;
  });
  return executeRentalOperation(operation);
}
export async function executeRentalOperation(operation: FinancialOperation) {
  if (!stripe || !operation.reservationId) throw new Error("Rental payment provider unavailable");
  const client = stripe;
  const payload = operation.payload as unknown as Stripe.PaymentIntentCreateParams;
  const intent = await runOperation(operation, {
    apply: async (tx, result) => {
      const payment = await tx.payment.findFirstOrThrow({ where: { reservationId: operation.reservationId!, type: "RENTAL", OR: [{ idempotencyKey: operation.key }, { stripePaymentIntentId: result.id }] } });
      return tx.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: result.id } });
    },
    create: key => client.paymentIntents.create({ ...payload, metadata: { ...payload.metadata, operationKey: key } }, { idempotencyKey: key }),
    retrieve: id => client.paymentIntents.retrieve(id),
    discover: async () => { for await (const p of client.paymentIntents.list({ customer: payload.customer as string, limit: 100 })) if (p.metadata.operationKey === operation.key) return p; return null; },
  });
  return intent;
}
