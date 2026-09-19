import { lockFinanceOperation } from "@/lib/payout-authority";
import { quarantineOperation } from "@/lib/financial-cases";
import { safeErrorCode } from "@/lib/safe-log";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type FinancialOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertEventFence, lockReservation } from "@/lib/financial-locks";
import { withOperationGuard, dispatchProviderCall } from "@/lib/provider-execution-guard";
import { OperationPendingError, UncertainOutcomeError } from "@/lib/financial-errors";
export { OperationPendingError, UncertainOutcomeError } from "@/lib/financial-errors";

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

export async function prepareOperation(tx: Prisma.TransactionClient, params: {
  key: string; kind: string; reservationId?: string; payload: Prisma.InputJsonValue;
}) {
  await assertEventFence(tx);
  const hash = fingerprint(params);
  const operation = await tx.financialOperation.upsert({
    where: { key: params.key }, create: { ...params, fingerprint: hash, priority: ["REFUND", "DEPOSIT_RELEASE"].includes(params.kind) ? 10 : params.kind === "RENTAL" ? 20 : 50 }, update: {},
  });
  if (operation.fingerprint !== hash) throw new Error("Idempotency key was reused with different parameters");
  return operation;
}

// Stripe does not fence requests on our behalf. Immutable keys protect concurrent
// in-flight calls; local tokens fence their results. Once the key's guaranteed
// retention window approaches, discovery is mandatory: never blindly recreate.
export async function runOperation<T extends { id: string }>(operation: FinancialOperation, provider: {
  create: (key: string) => Promise<T>;
  retrieve: (id: string) => Promise<T>;
  discover: () => Promise<T | null>;
  apply?: (tx: Prisma.TransactionClient, result: T) => Promise<unknown>;
  readBeforeDispatch?: () => Promise<T>;
  requiresDispatch?: (result: T) => boolean;
}): Promise<T> {
  const token = randomUUID();
  const claimed = await prisma.$transaction(async tx => {
    if (operation.kind.startsWith("FINANCE_")) await lockFinanceOperation(tx,operation);
    else if (operation.reservationId) await lockReservation(tx, operation.reservationId);
    else { await assertEventFence(tx); await tx.$queryRaw`SELECT financial_guard_xact(${"operation:" + operation.id})`; }
    if (operation.kind === "REFUND") {
      const refund = await tx.refund.findUnique({ where: { idempotencyKey: operation.key } });
      if (refund && refund.status !== "PENDING" && !refund.legacyUncertain) throw new OperationPendingError("Refund already terminal");
    }
    const now = new Date();
    const result = await tx.financialOperation.updateMany({
      where: { id: operation.id, state: { notIn: ["REVIEW", "DEAD_LETTER"] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 120000), state: "RUNNING", attempts: { increment: 1 } },
    });
    if (!result.count) throw new OperationPendingError("Financial operation is already processing");
    const current = await tx.financialOperation.findUniqueOrThrow({ where: { id: operation.id } });
    if (!current.firstAttemptAt) await tx.financialOperation.update({ where: { id: current.id }, data: { firstAttemptAt: now } });
    return current;
  });
  try {
    if (["REVIEW", "DEAD_LETTER"].includes(claimed.state)) throw new UncertainOutcomeError("Operation requires operator resolution");
    let observed: T | undefined;
    let dispatch = false;
    if (provider.readBeforeDispatch) {
      observed = await provider.readBeforeDispatch();
      dispatch = provider.requiresDispatch?.(observed) ?? false;
    } else if (claimed.providerId) observed = await provider.retrieve(claimed.providerId);
    else if (claimed.firstAttemptAt && Date.now() - claimed.firstAttemptAt.getTime() > 23 * 3600000) {
      const found = await provider.discover();
      if (!found) throw new UncertainOutcomeError("Provider outcome unknown beyond safe replay window; reconciliation required");
      observed = found;
    } else if (claimed.kind.startsWith("FINANCE_") && await prisma.financialDispatch.count({where:{operationId:claimed.id,phase:"DISPATCHED"}})) {
      const found=await provider.discover();
      if(!found)throw new UncertainOutcomeError("Dispatched finance outcome remains unknown; no new provider call is authorized");
      observed=found;
    } else if (claimed.kind === "DEPOSIT" && claimed.reservationId && (await prisma.reservation.findUniqueOrThrow({ where: { id: claimed.reservationId } })).financialDisposition !== "OPEN") {
      const found = await provider.discover();
      if (!found) throw new UncertainOutcomeError("Terminated reservation has an unresolved prior deposit attempt");
      observed = found;
    } else dispatch = true;
    const save = async (db: PrismaClient, result: T) => {
    const providerStatus = (result as T & { status?: string }).status;
    const polling = claimed.kind === "REFUND" ? !["succeeded", "failed", "canceled"].includes(providerStatus ?? "") : claimed.kind === "RENTAL" || claimed.kind === "DEPOSIT" && !["succeeded", "canceled"].includes(providerStatus ?? "");
    const nextPoll = providerStatus === "requires_capture" ? new Date(Date.now() + 3600000) : new Date(Date.now() + 60000);
    await db.$transaction(async tx => {
      if (claimed.kind.startsWith("FINANCE_")) await lockFinanceOperation(tx,claimed);
      else if (claimed.reservationId) await lockReservation(tx, claimed.reservationId);
      else await assertEventFence(tx);
      const saved = await tx.financialOperation.updateMany({
        where: { id: claimed.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } },
        data: { providerId: result.id, result: json(result), state: polling ? "POLL" : "OBSERVED", priority: providerStatus === "requires_capture" ? 90 : claimed.priority, leaseToken: null, leaseExpiresAt: null, lastError: null, consecutiveFailures: 0, nextAttemptAt: polling ? nextPoll : null },
      });
      if (!saved.count) throw new OperationPendingError("Financial operation lease lost; result will be reconciled");
      await provider.apply?.(tx, result);
    }, { timeout: 15000 });
    };
    return await withOperationGuard(claimed, token, async (db, current) => {
      const result = dispatch ? await dispatchProviderCall(db, current, token, () => provider.create(current.key)) : observed!;
      await save(db, result);
      return result;
    });
  } catch (error) {
    // Includes DB errors after provider success. Never turn uncertainty into a
    // terminal failure or free the reserved refund balance.
    await prisma.$transaction(async tx => {
      if (claimed.kind.startsWith("FINANCE_")) await lockFinanceOperation(tx,claimed);
      else if (claimed.reservationId) await lockReservation(tx, claimed.reservationId);
      const saved = await tx.financialOperation.updateMany({
      where: { id: claimed.id, leaseToken: token },
      data: { consecutiveFailures: { increment: 1 }, priority: ["REFUND", "DEPOSIT_RELEASE"].includes(claimed.kind) ? 10 : 20, state: error instanceof UncertainOutcomeError || claimed.consecutiveFailures >= 19 ? "REVIEW" : "RETRY", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + 30000), lastError: safeErrorCode(error) },
    });
      if (saved.count && (error instanceof UncertainOutcomeError || claimed.consecutiveFailures >= 19)) await quarantineOperation(tx, claimed.id, error instanceof UncertainOutcomeError ? error.message : safeErrorCode(error));
    });
    throw error;
  }
}
