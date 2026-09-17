import { safeLog } from "@/lib/safe-log";
import type { FinancialOperation } from "@prisma/client";
import { executeRentalOperation } from "@/lib/rental-payment";
import { withReservationLock } from "@/lib/financial-locks";
import { prepareOperation } from "@/lib/financial-operations";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { claimRecoverableStripeEvents } from "@/lib/stripe-event-ledger";
import { dispatchClaimedStripeEvent } from "@/lib/stripe-event-dispatch";
import { executeRefundOperation, reconcileRefundStatus } from "@/lib/refund-operations";
import { executeDepositOperation, executeDepositReleaseOperation, releaseDeposits } from "@/lib/deposit-authorization";
import { handlePaymentIntentSucceeded, settleTerminatedReservation } from "@/lib/stripe-webhook-handlers";
import { processOutboxOnce } from "@/lib/outbox";
import { expireStaleReservations } from "@/lib/cleanup";

async function each<T>(items: T[], run: (item: T) => Promise<unknown>) {
  let processed = 0, pending = 0;
  for (const item of items) try { await run(item); processed++; } catch (error) { pending++; safeLog("RECOVERY_PENDING", error); }
  return { processed, pending };
}
export async function recoverStripeEvents() {
  const events = await claimRecoverableStripeEvents(25);
  return each(events, async event => {
    const result = await dispatchClaimedStripeEvent({ eventRecordId: event.eventRecordId, leaseToken: event.leaseToken, event: event.payload as Stripe.Event });
    if (!result.ok) throw new Error("Event remains pending");
  });
}
export function dueOperations(kind: string) {
  const now = new Date();
  if (kind === "REFUND") return prisma.$queryRaw<FinancialOperation[]>`SELECT o.* FROM "FinancialOperation" o
    JOIN "Refund" f ON f."idempotencyKey" = o."key" AND f."reservationId" = o."reservationId"
    WHERE o."kind" = 'REFUND' AND o."state" IN ('READY','RETRY','POLL','RUNNING')
      AND f."status" = 'PENDING' AND NOT f."legacyUncertain" AND o."consecutiveFailures" < 20
      AND (o."nextAttemptAt" IS NULL OR o."nextAttemptAt" <= ${now})
      AND (o."leaseExpiresAt" IS NULL OR o."leaseExpiresAt" <= ${now})
    ORDER BY o."priority", o."nextAttemptAt" ASC NULLS FIRST, o."createdAt" LIMIT 25`;
  return prisma.financialOperation.findMany({ where: { kind, state: { in: ["READY", "RETRY", "POLL", "RUNNING"] }, consecutiveFailures: { lt: 20 }, AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }] }, orderBy: [{ priority: "asc" }, { nextAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }], take: 25 });
}
export async function recoverRefunds() {
  const legacyRefunds = await prisma.$queryRaw<Array<{ id: string }>>`SELECT f."id" FROM "Refund" f WHERE f."status"='PENDING' AND NOT f."legacyUncertain" AND f."stripeRefundId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."key"=f."idempotencyKey") ORDER BY f."createdAt" LIMIT 25`;
  const known = await prisma.refund.findMany({ where: { id: { in: legacyRefunds.map(f => f.id) } }, include: { payment: true } });
  for (const f of known) await withReservationLock(f.reservationId, async tx => {
    if (await tx.financialOperation.findUnique({ where: { key: f.idempotencyKey } })) return;
    const op = await prepareOperation(tx, { key: f.idempotencyKey, kind: "REFUND", reservationId: f.reservationId, payload: { refundId: f.id, paymentIntentId: f.payment.stripePaymentIntentId, amount: f.amountCents } });
    await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: f.stripeRefundId, firstAttemptAt: f.createdAt } });
  });
  const operations = await dueOperations("REFUND");
  const refunds = await prisma.refund.findMany({ where: { status: "PENDING", legacyUncertain: false, idempotencyKey: { in: operations.map(o => o.key) } }, include: { payment: true } });
  return each(refunds, async r => {
    // Rotate even uncertain/provider-failed items so one poisoned batch cannot
    // permanently starve later refunds. The operation lease owns execution.
    await prisma.refund.updateMany({ where: { id: r.id, status: "PENDING" }, data: { updatedAt: new Date() } });
    return executeRefundOperation(r.id, r.payment.stripePaymentIntentId);
  });
}
export async function recoverDeposits() {
  const legacyIds = await prisma.$queryRaw<Array<{ id: string }>>`SELECT d."id" FROM "SecurityDeposit" d
    JOIN "ProviderObjectOwnership" p ON p."providerId"=d."stripePaymentIntentId" AND p."kind"='DEPOSIT' AND p."reservationId"=d."reservationId"
    WHERE NOT d."legacyUncertain" AND d."stripePaymentIntentId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."reservationId" = d."reservationId" AND o."kind" = 'DEPOSIT') LIMIT 25`;
  const legacy = await prisma.securityDeposit.findMany({ where: { id: { in: legacyIds.map(d => d.id) } } });
  for (const deposit of legacy) await withReservationLock(deposit.reservationId, async tx => {
    if (await tx.financialOperation.count({ where: { reservationId: deposit.reservationId, kind: "DEPOSIT" } })) return;
    const op = await prepareOperation(tx, { key: `legacy-deposit:${deposit.reservationId}`, kind: "DEPOSIT", reservationId: deposit.reservationId, payload: { legacy: true } });
    await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: deposit.stripePaymentIntentId, generation: deposit.generation + 1, firstAttemptAt: deposit.createdAt } });
    await tx.securityDeposit.update({ where: { id: deposit.id }, data: { operationId: op.id, generation: { increment: 1 } } });
  });
  const releases = await dueOperations("DEPOSIT_RELEASE");
  const releaseCounts = { processed: 0, failed: 0, quarantined: 0 };
  for (const op of releases) {
    try { releaseCounts[await executeDepositReleaseOperation(op)]++; }
    catch (error) { releaseCounts.failed++; safeLog("RELEASE_RECOVERY_PENDING", error); }
  }
  const operations = await dueOperations("DEPOSIT");
  const deposits = await each(operations, async operation => {
    if (!operation.reservationId) return;
    const r = await prisma.reservation.findUnique({ where: { id: operation.reservationId } });
    if (!r) return;
    if (r.financialDisposition !== "OPEN" && !operation.firstAttemptAt) {
      await prisma.financialOperation.updateMany({ where: { id: operation.id, firstAttemptAt: null }, data: { nextAttemptAt: new Date(Date.now() + 86400000) } });
      return;
    }
    await executeDepositOperation(operation);
    if (["REFUND_REQUIRED", "TERMINATED"].includes((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).financialDisposition)) await releaseDeposits(r.id);
    else {
      const deposit = await prisma.securityDeposit.findUnique({ where: { reservationId: r.id } });
      const observed = await prisma.financialOperation.findUniqueOrThrow({ where: { id: operation.id } });
      if (deposit?.operationId && deposit.operationId !== observed.id && observed.providerId) await releaseDeposits(r.id, observed.providerId);
    }
  });
  return { processed: deposits.processed + releaseCounts.processed, pending: deposits.pending + releaseCounts.failed,
    failed: deposits.pending + releaseCounts.failed, quarantined: releaseCounts.quarantined, releases: releaseCounts, deposits };
}
export async function recoverReconciliation() {
  await expireStaleReservations();
  if (!stripe) throw new Error("Stripe unavailable");
  const rentals = await dueOperations("RENTAL");
  const recovered = await each(rentals, async operation => {
    const intent = await executeRentalOperation(operation);
    if (intent.status === "succeeded") await handlePaymentIntentSucceeded(intent);
    if (operation.reservationId) await withReservationLock(operation.reservationId, async tx => {
      const current = await tx.reservation.findUniqueOrThrow({ where: { id: operation.reservationId! } });
      if (intent.status === "canceled" || (intent.status === "succeeded" && !["CHECKOUT_HOLD", "AWAITING_PAYMENT", "PAYMENT_FAILED", "EXPIRED"].includes(current.status)) || ["TERMINATED", "REVIEW"].includes(current.financialDisposition)) {
        await tx.financialOperation.updateMany({ where: { id: operation.id, state: "POLL", leaseToken: null, providerId: intent.id }, data: { state: "OBSERVED", nextAttemptAt: null } });
      }
    });
  });
  return recovered;
}
export async function auditHistoricalFinancials() {
  if (!stripe) throw new Error("Stripe unavailable");
  const client = stripe;
  const reservations = await prisma.reservation.findMany({ where: { payments: { some: { type: "RENTAL" } } }, orderBy: [{ financialCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: 25, include: { payments: true } });
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
  "historical-audit": auditHistoricalFinancials,
  outbox: processOutboxOnce,
};
