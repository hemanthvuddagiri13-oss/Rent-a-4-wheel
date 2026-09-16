import { executeRentalOperation } from "@/lib/rental-payment";
import { withReservationLock } from "@/lib/financial-locks";
import { prepareOperation } from "@/lib/financial-operations";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { claimRecoverableStripeEvents } from "@/lib/stripe-event-ledger";
import { dispatchClaimedStripeEvent } from "@/lib/stripe-event-dispatch";
import { executeRefundOperation, reconcileRefundStatus } from "@/lib/refund-operations";
import { executeDepositOperation, releaseDeposits } from "@/lib/deposit-authorization";
import { handlePaymentIntentSucceeded, settleTerminatedReservation } from "@/lib/stripe-webhook-handlers";
import { processOutboxOnce } from "@/lib/outbox";
import { expireStaleReservations } from "@/lib/cleanup";

async function each<T>(items: T[], run: (item: T) => Promise<unknown>) {
  let processed = 0, pending = 0;
  for (const item of items) try { await run(item); processed++; } catch (error) { pending++; console.error("Recovery pending", String(error)); }
  return { processed, pending };
}
export async function recoverStripeEvents() {
  const events = await claimRecoverableStripeEvents(25);
  return each(events, async event => {
    const result = await dispatchClaimedStripeEvent({ eventRecordId: event.eventRecordId, leaseToken: event.leaseToken, event: event.payload as Stripe.Event });
    if (!result.ok) throw new Error("Event remains pending");
  });
}
export async function recoverRefunds() {
  const refunds = await prisma.refund.findMany({ where: { status: "PENDING" }, include: { payment: true }, orderBy: { updatedAt: "asc" }, take: 25 });
  return each(refunds, async r => {
    // Rotate even uncertain/provider-failed items so one poisoned batch cannot
    // permanently starve later refunds. The operation lease owns execution.
    await prisma.refund.updateMany({ where: { id: r.id, status: "PENDING" }, data: { updatedAt: new Date() } });
    return executeRefundOperation(r.id, r.payment.stripePaymentIntentId);
  });
}
export async function recoverDeposits() {
  const legacyIds = await prisma.$queryRaw<Array<{ id: string }>>`SELECT d."id" FROM "SecurityDeposit" d WHERE d."stripePaymentIntentId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."reservationId" = d."reservationId" AND o."kind" = 'DEPOSIT') LIMIT 25`;
  const legacy = await prisma.securityDeposit.findMany({ where: { id: { in: legacyIds.map(d => d.id) } } });
  for (const deposit of legacy) await withReservationLock(deposit.reservationId, async tx => {
    if (await tx.financialOperation.count({ where: { reservationId: deposit.reservationId, kind: "DEPOSIT" } })) return;
    const op = await prepareOperation(tx, { key: `legacy-deposit:${deposit.reservationId}`, kind: "DEPOSIT", reservationId: deposit.reservationId, payload: { legacy: true } });
    await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: deposit.stripePaymentIntentId, firstAttemptAt: deposit.createdAt } });
  });
  const operations = await prisma.financialOperation.findMany({ where: { kind: "DEPOSIT", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] }, orderBy: { updatedAt: "asc" }, take: 25 });
  return each(operations, async operation => {
    if (!operation.reservationId) return;
    const r = await prisma.reservation.findUnique({ where: { id: operation.reservationId } });
    if (!r) return;
    if (r.financialDisposition !== "OPEN" && !operation.firstAttemptAt) {
      await prisma.financialOperation.updateMany({ where: { id: operation.id, firstAttemptAt: null }, data: { nextAttemptAt: new Date(Date.now() + 86400000) } });
      return;
    }
    await executeDepositOperation(operation);
    if (r.financialDisposition !== "OPEN") await releaseDeposits(r.id);
    else {
      const latest = await prisma.financialOperation.findFirst({ where: { reservationId: r.id, kind: "DEPOSIT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const observed = await prisma.financialOperation.findUniqueOrThrow({ where: { id: operation.id } });
      if (latest?.id !== observed.id && observed.providerId) await releaseDeposits(r.id, observed.providerId);
    }
  });
}
export async function recoverReconciliation() {
  await expireStaleReservations();
  if (!stripe) throw new Error("Stripe unavailable");
  const client = stripe;
  const rentals = await prisma.financialOperation.findMany({ where: { kind: "RENTAL", providerId: null }, orderBy: { updatedAt: "asc" }, take: 25 });
  await each(rentals, executeRentalOperation);
  const reservations = await prisma.reservation.findMany({ where: { payments: { some: { type: "RENTAL" } } }, orderBy: { financialCheckedAt: { sort: "asc", nulls: "first" } }, take: 25, include: { payments: true } });
  return each(reservations, async r => {
    await prisma.reservation.update({ where: { id: r.id }, data: { financialCheckedAt: new Date() } });
    for (const payment of r.payments.filter(p => p.type === "RENTAL" && p.stripePaymentIntentId)) {
      const intent = await client.paymentIntents.retrieve(payment.stripePaymentIntentId!);
      if (intent.status === "succeeded") await handlePaymentIntentSucceeded(intent);
      for await (const refund of client.refunds.list({ payment_intent: intent.id, limit: 100 })) await reconcileRefundStatus(refund.id, refund.status ?? "");
    }
    if (r.financialDisposition !== "OPEN") await settleTerminatedReservation(r.id);
  });
}
export const financialWorkers = {
  "stripe-events": recoverStripeEvents,
  refunds: recoverRefunds,
  deposits: recoverDeposits,
  reconciliation: recoverReconciliation,
  outbox: processOutboxOnce,
};
