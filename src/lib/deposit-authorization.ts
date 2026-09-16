import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import type { FinancialOperation, SecurityDeposit, Prisma } from "@prisma/client";
import { withReservationLock } from "@/lib/financial-locks";
import { json, prepareOperation, runOperation } from "@/lib/financial-operations";

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
    const deposit = await tx.securityDeposit.findUnique({ where: { reservationId } });
    if (!deposit) throw new Error("Required deposit record missing");
    // Ignore observations from older attempts once a newer attempt owns the row.
    const latest = await tx.financialOperation.findFirst({ where: { reservationId, kind: "DEPOSIT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (latest && latest.providerId !== intent.id) return;
    valid = intent.status === "requires_capture" && intent.currency === "usd" &&
      intent.amount === deposit.amountCents && intent.amount_capturable >= deposit.amountCents &&
      typeof expires === "number" && expires * 1000 > Date.now();
    await tx.securityDeposit.update({ where: { reservationId }, data: {
      stripePaymentIntentId: intent.id, stripeStatus: intent.status,
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
  if (retry && reservation.deposit?.authorizationExpiresAt && reservation.deposit.authorizationExpiresAt <= new Date()) await releaseDeposits(reservation.id);
  const prepared = await withReservationLock(reservation.id, async tx => {
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true } });
    if (current.depositCents === 0) return null;
    if (current.financialDisposition !== "OPEN" || ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST", "EXPIRED"].includes(current.status)) throw new Error("Reservation financially terminated");
    if (!current.deposit || current.deposit.amountCents !== current.depositCents) throw new Error("Required deposit record missing or inconsistent");
    if (!stripe) throw new Error("Deposit provider unavailable");
    const latest = await tx.financialOperation.findFirst({ where: { reservationId: current.id, kind: "DEPOSIT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!latest && current.deposit.stripePaymentIntentId) {
      const legacy = await prepareOperation(tx, { key: `legacy-deposit:${current.id}`, kind: "DEPOSIT", reservationId: current.id, payload: { legacy: true } });
      return tx.financialOperation.update({ where: { id: legacy.id }, data: { providerId: current.deposit.stripePaymentIntentId, firstAttemptAt: current.deposit.createdAt } });
    }
    if (latest && !(retry && ["requires_payment_method", "canceled"].includes(current.deposit.stripeStatus ?? "") && latest.providerId)) return latest;
    const pm = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
    const customer = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
    if (!pm || !customer) throw new Error("Saved payment method and customer required");
    const sequence = await tx.financialOperation.count({ where: { reservationId: current.id, kind: "DEPOSIT" } });
    return prepareOperation(tx, { key: `deposit:${current.id}:${sequence + 1}`, kind: "DEPOSIT", reservationId: current.id,
      payload: json({ amount: current.depositCents, currency: "usd", customer, payment_method: pm, capture_method: "manual", confirm: true, off_session: true, metadata: { reservationId: current.id, purpose: "security_deposit" } }) });
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
  if (!stripe) throw new Error("Stripe unavailable");
  const client = stripe;
  const attempts = await prisma.financialOperation.findMany({ where: { reservationId, kind: "DEPOSIT", providerId: onlyIntentId ?? { not: null } } });
  for (const attempt of attempts) {
    const intentId = attempt.providerId!;
    const operation = await withReservationLock(reservationId, tx => prepareOperation(tx, {
      key: `deposit-release:${intentId}`, kind: "DEPOSIT_RELEASE", reservationId, payload: { intentId },
    }));
    await runOperation(operation, {
      apply: (tx, result) => syncDepositIntent(reservationId, result, tx),
      create: async key => {
        const current = await client.paymentIntents.retrieve(intentId);
        return ["canceled", "succeeded"].includes(current.status) ? current : client.paymentIntents.cancel(intentId, {}, { idempotencyKey: key });
      },
      retrieve: id => client.paymentIntents.retrieve(id),
      discover: () => client.paymentIntents.retrieve(intentId),
    });

  }
}

export async function handleDepositAuthorizationCanceled(intent: Stripe.PaymentIntent) {
  if (intent.metadata?.purpose !== "security_deposit" || !stripe) return;
  const deposit = await prisma.securityDeposit.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (deposit) await syncDepositIntent(deposit.reservationId, await stripe.paymentIntents.retrieve(intent.id));
}
