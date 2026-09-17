import { planDepositRelease } from "@/lib/deposit-release-plan";
import { checkDepositReleaseOwnership } from "@/lib/deposit-release-ownership";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import type { FinancialOperation, SecurityDeposit, Prisma } from "@prisma/client";
import { withReservationLock } from "@/lib/financial-locks";
import { json, prepareOperation, runOperation, UncertainOutcomeError } from "@/lib/financial-operations";

export function isTransientStripeError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeError && ["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"].includes(err.type);
}
export type DepositAuthorizationOutcome =
  | { outcome: "not_required" }
  | { outcome: "already_valid" }
  | { outcome: "succeeded"; depositIntentId: string; authorizedAt: Date; authorizationExpiresAt: Date }
  | { outcome: "failed"; failureReason: string };

export async function syncDepositIntent(reservationId: string, intent: Stripe.PaymentIntent, lockedTx?: Prisma.TransactionClient) {
  if (!stripe) throw new Error("Stripe unavailable");
  let charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  if (typeof intent.latest_charge === "string") charge = await stripe.charges.retrieve(intent.latest_charge);
  const expires = charge?.payment_method_details?.card?.capture_before;
  let valid = false;
  const authorizationExpiresAt = expires ? new Date(expires * 1000) : null;
  const apply = async (tx: Prisma.TransactionClient) => {
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const observedOp = await tx.financialOperation.findFirst({ where: { reservationId, kind: "DEPOSIT", providerId: intent.id } });
    const deposit = await tx.securityDeposit.findUnique({ where: { reservationId } });
    if (!deposit) throw new Error("Required deposit record missing");
    if (intent.status !== "canceled" && observedOp && (["REFUND_REQUIRED", "TERMINATED"].includes(current.financialDisposition) || (deposit.operationId && deposit.operationId !== observedOp.id))) await planDepositRelease(tx, reservationId, intent.id);
    // Ignore observations from older attempts once a newer attempt owns the row.
    const latest = deposit.operationId ? await tx.financialOperation.findUnique({ where: { id: deposit.operationId } }) : null;
    if (!latest || latest.providerId !== intent.id || latest.generation !== deposit.generation || deposit.legacyUncertain) return;
    if (deposit.stripePaymentIntentId === intent.id && (deposit.status === "CANCELLED" || ["canceled", "succeeded"].includes(deposit.stripeStatus ?? "") || deposit.releasedAt) && !["canceled", "succeeded"].includes(intent.status)) return;
    if (deposit.stripePaymentIntentId === intent.id && deposit.authorizationExpiresAt && deposit.authorizationExpiresAt <= new Date() && intent.status === "requires_capture") return;
    valid = intent.status === "requires_capture" && intent.currency === "usd" &&
      intent.amount === deposit.amountCents && intent.amount_capturable >= deposit.amountCents &&
      typeof expires === "number" && expires * 1000 > Date.now();
    await tx.securityDeposit.update({ where: { reservationId }, data: {
      stripePaymentIntentId: intent.id, stripeStatus: intent.status, capturableAmountCents: intent.amount_capturable,
      releasedAt: intent.status === "canceled" ? (deposit.releasedAt ?? new Date()) : deposit.stripePaymentIntentId === intent.id ? deposit.releasedAt : null,
      status: valid ? "SUCCEEDED" : intent.status === "canceled" ? "CANCELLED" : "FAILED",
      authorizedAt: charge ? new Date(charge.created * 1000) : null, authorizationExpiresAt,
      failureReason: valid ? null : `Deposit requires recovery: ${intent.status}`,
    } });
  };
  if (lockedTx) await apply(lockedTx); else await withReservationLock(reservationId, apply);
  return valid && authorizationExpiresAt
    ? { outcome: "succeeded" as const, depositIntentId: intent.id, authorizedAt: charge ? new Date(charge.created * 1000) : new Date(intent.created * 1000), authorizationExpiresAt }
    : { outcome: "failed" as const, failureReason: `Deposit authorization unavailable (${intent.status})` };
}

export async function attemptDepositAuthorization(
  reservation: { id: string; deposit: SecurityDeposit | null }, intent: Stripe.PaymentIntent, retry = false
): Promise<DepositAuthorizationOutcome> {
  const observedGeneration = reservation.deposit?.generation;
  if (retry && reservation.deposit?.stripePaymentIntentId && reservation.deposit.authorizationExpiresAt && reservation.deposit.authorizationExpiresAt <= new Date()) await releaseDeposits(reservation.id, reservation.deposit.stripePaymentIntentId);
  const prepared = await withReservationLock(reservation.id, async tx => {
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true } });
    if (current.depositCents === 0) return null;
    if (current.financialDisposition !== "OPEN" || ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST", "EXPIRED"].includes(current.status)) throw new Error("Reservation financially terminated");
    if (!current.deposit || current.deposit.amountCents !== current.depositCents) throw new Error("Required deposit record missing or inconsistent");
    if (current.deposit.legacyUncertain) throw new Error("Legacy deposit outcome requires manual reconciliation");
    if (!stripe) throw new Error("Deposit provider unavailable");
    const latest = current.deposit.operationId ? await tx.financialOperation.findUnique({ where: { id: current.deposit.operationId } }) : null;
    if (!latest && current.deposit.stripePaymentIntentId) {
      const legacy = await prepareOperation(tx, { key: `legacy-deposit:${current.id}`, kind: "DEPOSIT", reservationId: current.id, payload: { legacy: true } });
      await tx.securityDeposit.update({ where: { reservationId: current.id }, data: { operationId: legacy.id, generation: { increment: 1 } } });
      return tx.financialOperation.update({ where: { id: legacy.id }, data: { providerId: current.deposit.stripePaymentIntentId, generation: current.deposit.generation + 1, firstAttemptAt: current.deposit.createdAt } });
    }
    if (latest && (latest.generation !== current.deposit.generation || latest.reservationId !== current.id || latest.kind !== "DEPOSIT")) throw new Error("Deposit generation ownership mismatch");
    if (latest && (observedGeneration !== current.deposit.generation || !(retry && ["requires_payment_method", "canceled"].includes(current.deposit.stripeStatus ?? "") && latest.providerId))) return latest;
    const pm = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
    const customer = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
    if (!pm || !customer) throw new Error("Saved payment method and customer required");
    const sequence = await tx.financialOperation.count({ where: { reservationId: current.id, kind: "DEPOSIT" } });
    const operation = await prepareOperation(tx, { key: `deposit:${current.id}:${sequence + 1}`, kind: "DEPOSIT", reservationId: current.id,
      payload: json({ amount: current.depositCents, currency: "usd", customer, payment_method: pm, capture_method: "manual", confirm: true, off_session: true, metadata: { reservationId: current.id, purpose: "security_deposit" } }) });
    await tx.securityDeposit.update({ where: { reservationId: current.id }, data: { operationId: operation.id, generation: { increment: 1 } } });
    return tx.financialOperation.update({ where: { id: operation.id }, data: { generation: current.deposit.generation + 1 } });
  });
  if (!prepared) return { outcome: "not_required" };
  return executeDepositOperation(prepared);
}

export async function executeDepositOperation(prepared: FinancialOperation): Promise<DepositAuthorizationOutcome> {
  if (!prepared.reservationId) throw new Error("Deposit reservation missing");
  if (!stripe) throw new Error("Stripe unavailable");
  const client = stripe;
  const payload = prepared.payload as unknown as Stripe.PaymentIntentCreateParams;
  let outcome: DepositAuthorizationOutcome = { outcome: "failed", failureReason: "Deposit not observed" };
  await runOperation(prepared, {
    apply: async (tx, result) => { outcome = await syncDepositIntent(prepared.reservationId!, result, tx); },
    create: async key => {
      try { return await client.paymentIntents.create({ ...payload, metadata: { ...payload.metadata, operationKey: key } }, { idempotencyKey: key }); }
      catch (error) {
        if (error instanceof Stripe.errors.StripeCardError && error.payment_intent && typeof error.payment_intent === "object") return error.payment_intent;
        throw error;
      }
    },
    retrieve: id => client.paymentIntents.retrieve(id),
    discover: async () => {
      for await (const item of client.paymentIntents.list({ customer: payload.customer as string, limit: 100 })) if (item.metadata.operationKey === prepared.key) return item;
      return null;
    },
  });
  return outcome;
}

export async function releaseDeposits(reservationId: string, onlyIntentId?: string) {
  const attempts = await prisma.financialOperation.findMany({ where: { reservationId, kind: "DEPOSIT", providerId: onlyIntentId ?? { not: null } } });
  const targets = new Set(attempts.map(a => a.providerId!));
  const deposit = await prisma.securityDeposit.findUnique({ where: { reservationId } });
  if (deposit?.stripePaymentIntentId && (!onlyIntentId || onlyIntentId === deposit.stripePaymentIntentId)) targets.add(deposit.stripePaymentIntentId);
  for (const intentId of targets) {
    const operation = await withReservationLock(reservationId, tx => prepareOperation(tx, {
      key: `deposit-release:${intentId}`, kind: "DEPOSIT_RELEASE", reservationId, payload: { intentId },
    }));
    await executeDepositReleaseOperation(operation);
  }
}

export async function executeDepositReleaseOperation(operation: FinancialOperation): Promise<"processed" | "quarantined"> {
    const reservationId = operation.reservationId;
    if (!reservationId) throw new Error("Release reservation missing");
    if (!await checkDepositReleaseOwnership(operation.id, reservationId)) return "quarantined";
    if (!stripe) throw new Error("Stripe unavailable");
    const client = stripe;
    const intentId = (operation.payload as { intentId: string }).intentId;
    const cancelExactIntent = async () => {
      if (!await checkDepositReleaseOwnership(operation.id, reservationId)) throw new UncertainOutcomeError("Deposit release quarantined");
      const current = await client.paymentIntents.retrieve(intentId);
      if (current.status === "canceled") return current;
      if (current.status === "succeeded") throw new UncertainOutcomeError("Captured deposit requires manual resolution");
      const canceled = await client.paymentIntents.cancel(intentId, {}, { idempotencyKey: operation.key });
      if (canceled.status !== "canceled") throw new Error("Deposit release unresolved");
      return canceled;
    };
    try { await runOperation(operation, {
      apply: (tx, result) => syncDepositIntent(reservationId, result, tx),
      // A release's provider ID identifies its immutable target, not proof of
      // cancellation. It is safe to cancel that exact still-live target again.
      create: cancelExactIntent,
      retrieve: cancelExactIntent,
      discover: cancelExactIntent,
    }); } catch (error) {
      const current = await prisma.financialOperation.findUniqueOrThrow({ where: { id: operation.id } });
      if (current.state === "REVIEW") return "quarantined";
      throw error;
    }
    return "processed";
}

export async function handleDepositAuthorizationCanceled(intent: Stripe.PaymentIntent) {
  if (intent.metadata?.purpose !== "security_deposit" || !stripe) return;
  const deposit = await prisma.securityDeposit.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (deposit) await syncDepositIntent(deposit.reservationId, await stripe.paymentIntents.retrieve(intent.id));
}
