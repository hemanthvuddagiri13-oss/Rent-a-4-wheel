import { financeOperationScopes, assertFinanceDispatch } from "@/lib/payout-authority";
import { type PrismaClient, type FinancialOperation, type Prisma } from "@prisma/client";
import { prisma, createSafePrismaClient } from "@/lib/prisma";
import { eventFence } from "@/lib/financial-locks";
import { OperationPendingError, UncertainOutcomeError } from "@/lib/financial-errors";
import { safeErrorCode } from "@/lib/safe-log";
import { assertDepositReleaseReviewClear } from "@/lib/return-financial-authority";
import { requireReleaseFeature } from "@/lib/release-control";
import {requireReservationJurisdiction,jurisdictionDecision} from "@/lib/jurisdiction";

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)); }

// A private one-connection pool pins a physical PostgreSQL session for the whole
// dispatch. DIRECT_DATABASE_URL must bypass transaction-mode connection poolers.
// The backend identity is checked again immediately before the external call.
export async function withOperationGuard<T>(operation: FinancialOperation, token: string, run: (db: PrismaClient, current: FinancialOperation) => Promise<T>) {
  const reservation = operation.reservationId ? await prisma.reservation.findUniqueOrThrow({ where: { id: operation.reservationId } }) : null;
  const scope = reservation ? "vehicle:" + reservation.vehicleId : "operation:" + operation.id;
  const fence = eventFence.getStore();
  const scopes = [ ...(fence ? ["event:" + fence.id] : []), ...(operation.kind.startsWith("FINANCE_") ? await financeOperationScopes(prisma,operation) : [scope])];
  const url = new URL(process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL!);
  if (url.searchParams.get("pgbouncer") === "true") throw new Error("Dispatch requires a direct PostgreSQL session");
  url.searchParams.set("connection_limit", "1"); url.searchParams.set("pool_timeout", "15");
  const db = createSafePrismaClient(url.toString());
  const held: string[] = []; let releaseHeld = false;
  try {
    await db.$connect(); await db.$executeRawUnsafe("SET lock_timeout='12s'");
    await db.$queryRaw`SELECT pg_advisory_lock_shared(hashtextextended('release-control',0))::text`; releaseHeld = true;
    for (const key of scopes) { await db.$queryRaw`SELECT financial_guard_session(${key},true)`; held.push(key); }
    const current = await assertCurrentLease(db, operation, token);
    if (reservation && (await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).vehicleId !== reservation.vehicleId) throw new OperationPendingError("Reservation guard identity changed");
    if (fence) {
      const valid = await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "StripeEvent" WHERE "id"=${fence.id} AND "leaseToken"=${fence.token} AND "status"='PROCESSING' AND "processingStartedAt">(clock_timestamp() AT TIME ZONE 'UTC')-interval '2 minutes'`;
      if (!valid.length) throw new OperationPendingError("Stripe event lease lost before dispatch");
    }
    return await run(db, current);
  } finally {
    try { for (const key of held.reverse()) await db.$queryRaw`SELECT financial_guard_session(${key},false)`; }
    finally { if(releaseHeld) await db.$queryRaw`SELECT pg_advisory_unlock_shared(hashtextextended('release-control',0))`; await db.$disconnect(); }
  }
}

export async function assertCurrentLease(db: PrismaClient, operation: FinancialOperation, token: string) {
  const rows = await db.$queryRaw<FinancialOperation[]>`SELECT * FROM "FinancialOperation" WHERE "id"=${operation.id} AND "leaseToken"=${token}
    AND "leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AND "state"='RUNNING'`;
  if (rows.length !== 1 || rows[0].kind !== operation.kind || rows[0].reservationId !== operation.reservationId || rows[0].fingerprint !== operation.fingerprint) throw new OperationPendingError("Financial operation lease lost before provider dispatch");
  return rows[0];
}

async function assertDispatchAuthority(db: PrismaClient, op: FinancialOperation) {
  // Admission gates do not block compensating refunds, deposit releases or reversals.
  if(op.kind==="RENTAL"||op.kind==="DEPOSIT"){const jurisdiction=await requireReservationJurisdiction(db,op.reservationId!,"PAYMENT");await requireReleaseFeature(op.kind==="RENTAL"?"booking":"deposits",db,jurisdiction.code);}
  if(op.kind==="FINANCE_CONNECT"){const host=await db.hostProfile.findUniqueOrThrow({where:{id:(op.payload as {hostId:string}).hostId}});const jurisdiction=await jurisdictionDecision(db,host.jurisdictionCode,"HOSTING");await requireReleaseFeature("connect",db,jurisdiction.code);}
  if(op.kind==="FINANCE_TRANSFER"||op.kind==="FINANCE_PAYOUT"){const items=await db.payoutItem.findMany({where:{batchId:(op.payload as {batchId:string}).batchId}});for(const item of items){const jurisdiction=await requireReservationJurisdiction(db,item.reservationId,"PAYOUT");await requireReleaseFeature(op.kind==="FINANCE_TRANSFER"?"transfers":"payouts",db,jurisdiction.code);}}
  if (op.kind.startsWith("FINANCE_")) { await assertFinanceDispatch(db,op); return; }
  if (!op.reservationId) { if (op.kind !== "CUSTOMER") throw new UncertainOutcomeError("Provider operation has no release authority"); return; }
  const r = await db.reservation.findUniqueOrThrow({ where: { id: op.reservationId }, include: { deposit: true, trip: true } });
  const payload = op.payload as { intentId?: string; amount?: number; currency?: string; refundId?: string; paymentIntentId?: string };
  if (op.kind === "DEPOSIT_RELEASE") {
    await assertDepositReleaseReviewClear(db, r.id);
    const target = payload.intentId;
    const ownership = target ? await db.providerObjectOwnership.findUnique({ where: { providerId: target } }) : null;
    const originals = target ? await db.financialOperation.findMany({ where: { kind: "DEPOSIT", reservationId: r.id, providerId: target } }) : [];
    if (!target || ownership?.kind !== "DEPOSIT" || ownership.reservationId !== r.id || originals.length !== 1 || ownership.operationId !== originals[0].id || (op.providerId && op.providerId !== target)) throw new UncertainOutcomeError("Deposit release ownership invalid at dispatch");
    const original = originals[0];
    if (original.generation === null) throw new UncertainOutcomeError("Deposit release generation unknown");
    if (op.generation === null) await db.financialOperation.update({ where: { id: op.id }, data: { generation: original.generation } });
    else if (op.generation !== original.generation) throw new UncertainOutcomeError("Deposit release generation mismatch");
    const superseded = r.deposit?.operationId && r.deposit.operationId !== original.id && r.deposit.generation > original.generation;
    const expired = r.deposit?.stripePaymentIntentId === target && r.deposit.authorizationExpiresAt && r.deposit.authorizationExpiresAt <= new Date();
    if (!["REFUND_REQUIRED", "TERMINATED"].includes(r.financialDisposition) && r.status !== "COMPLETED" && !r.status.startsWith("CANCELLED") && !superseded && !expired) throw new UncertainOutcomeError("Reservation no longer authorizes deposit release");
  } else if (op.kind === "DEPOSIT") {
    if (r.financialDisposition !== "OPEN" || r.status.startsWith("CANCELLED") || r.status === "EXPIRED" || !r.deposit || r.deposit.legacyUncertain || r.deposit.operationId !== op.id || r.deposit.generation !== op.generation || payload.amount !== r.deposit.amountCents || payload.amount !== r.depositCents) throw new UncertainOutcomeError("Deposit authorization no longer permitted");
  } else if (op.kind === "REFUND") {
    const f = await db.refund.findUnique({ where: { idempotencyKey: op.key }, include: { payment: true } });
    const owner = payload.paymentIntentId ? await db.providerObjectOwnership.findUnique({ where: { providerId: payload.paymentIntentId } }) : null;
    if (!owner || owner.kind !== "RENTAL" || owner.reservationId !== r.id || owner.paymentId !== f?.paymentId) throw new UncertainOutcomeError("Refund rental ownership no longer valid");
    if (!f || f.reservationId !== r.id || f.status !== "PENDING" || f.legacyUncertain || f.id !== payload.refundId || f.amountCents !== payload.amount || f.payment.type !== "RENTAL" || f.payment.status !== "SUCCEEDED" || f.payment.stripePaymentIntentId !== payload.paymentIntentId || r.financialDisposition === "REVIEW" || r.trip?.startedAt || ["ACTIVE", "RETURN_IN_PROGRESS", "COMPLETED", "DISPUTED", "UNDER_CLAIM_REVIEW"].includes(r.status)) throw new UncertainOutcomeError("Refund authority no longer valid");
  } else if (op.kind === "RENTAL") {
    if (r.financialDisposition !== "OPEN" || r.status !== "AWAITING_PAYMENT" || !r.expiresAt || r.expiresAt <= new Date()) throw new UncertainOutcomeError("Rental checkout no longer payable");
  } else throw new UncertainOutcomeError("Unsupported financial operation kind");
}

export async function dispatchProviderCall<T extends { id: string }>(db: PrismaClient, op: FinancialOperation, token: string, call: () => Promise<T>) {
  await assertCurrentLease(db, op, token);
  await assertDispatchAuthority(db, op);
  // Extend only a still-valid lease. Takeovers and all authority writers are
  // excluded until the bounded request and durable result have completed.
  const renewed = await db.$queryRaw<Array<{ id: string }>>`UPDATE "FinancialOperation" SET "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '2 minutes'
    WHERE "id"=${op.id} AND "leaseToken"=${token} AND "state"='RUNNING' AND "leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC') RETURNING "id"`;
  if (!renewed.length) throw new OperationPendingError("Financial operation lease expired during authorization");
  const fence = eventFence.getStore();
  if (fence) {
    const renewedEvent = await db.$queryRaw<Array<{ id: string }>>`UPDATE "StripeEvent" SET "processingStartedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id"=${fence.id} AND "leaseToken"=${fence.token} AND "status"='PROCESSING' AND "processingStartedAt">(clock_timestamp() AT TIME ZONE 'UTC')-interval '2 minutes' RETURNING "id"`;
    if (!renewedEvent.length) throw new OperationPendingError("Stripe event lease expired during authorization");
  }
  const scope = op.reservationId ? "vehicle:" + (await db.reservation.findUniqueOrThrow({ where: { id: op.reservationId } })).vehicleId : "operation:" + op.id;
  for (const guardScope of op.kind.startsWith("FINANCE_") ? await financeOperationScopes(db,op) : [scope]) {
  const locked = await db.$queryRaw<Array<{ held: boolean }>>`SELECT count(*)=2 AS held FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND ((classid::bigint<<32) | objid::bigint) IN (SELECT * FROM financial_guard_keys(${guardScope}))`;
  if (!locked[0]?.held) throw new OperationPendingError("Dedicated PostgreSQL session lost its guard");
  }
  await db.financialDispatch.create({ data: { operationId: op.id, leaseToken: token, phase: "DISPATCHED", providerId: op.providerId } });
  try {
    const result = await call();
    // Separate commit from projection: a projection crash cannot erase proof of
    // provider acceptance. Recovery can retrieve this exact provider identity.
    await db.$transaction(async tx => {
      await tx.financialDispatch.create({ data: { operationId: op.id, leaseToken: token, phase: "SUCCEEDED", providerId: result.id, result: json(result) } });
      await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: result.id, result: json(result) } });
    });
    return result;
  } catch (error) {
    await db.financialDispatch.create({ data: { operationId: op.id, leaseToken: token, phase: "UNCERTAIN", errorCode: safeErrorCode(error) } });
    throw error;
  }
}
