import { createHash, randomUUID } from "node:crypto";
import { Prisma, type FinancialOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertEventFence, lockReservation } from "@/lib/financial-locks";

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
    where: { key: params.key }, create: { ...params, fingerprint: hash }, update: {},
  });
  if (operation.fingerprint !== hash) throw new Error("Idempotency key was reused with different parameters");
  return operation;
}

export class OperationPendingError extends Error {}
export class UncertainOutcomeError extends OperationPendingError {}

// Stripe does not fence requests on our behalf. Immutable keys protect concurrent
// in-flight calls; local tokens fence their results. Once the key's guaranteed
// retention window approaches, discovery is mandatory: never blindly recreate.
export async function runOperation<T extends { id: string }>(operation: FinancialOperation, provider: {
  create: (key: string) => Promise<T>;
  retrieve: (id: string) => Promise<T>;
  discover: () => Promise<T | null>;
  apply?: (tx: Prisma.TransactionClient, result: T) => Promise<unknown>;
}): Promise<T> {
  const token = randomUUID();
  const claimed = await prisma.$transaction(async tx => {
    await assertEventFence(tx);
    const now = new Date();
    const result = await tx.financialOperation.updateMany({
      where: { id: operation.id, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 120000), state: "RUNNING", attempts: { increment: 1 } },
    });
    if (!result.count) throw new OperationPendingError("Financial operation is already processing");
    const current = await tx.financialOperation.findUniqueOrThrow({ where: { id: operation.id } });
    if (!current.firstAttemptAt) await tx.financialOperation.update({ where: { id: current.id }, data: { firstAttemptAt: now } });
    return current;
  });
  try {
    let result: T;
    if (claimed.providerId) result = await provider.retrieve(claimed.providerId);
    else if (claimed.firstAttemptAt && Date.now() - claimed.firstAttemptAt.getTime() > 23 * 3600000) {
      const found = await provider.discover();
      if (!found) throw new UncertainOutcomeError("Provider outcome unknown beyond safe replay window; reconciliation required");
      result = found;
    } else result = await provider.create(claimed.key);
    await prisma.$transaction(async tx => {
      if (claimed.reservationId) await lockReservation(tx, claimed.reservationId);
      else await assertEventFence(tx);
      const saved = await tx.financialOperation.updateMany({
        where: { id: claimed.id, leaseToken: token, leaseExpiresAt: { gt: new Date() } },
        data: { providerId: result.id, result: json(result), state: "OBSERVED", leaseToken: null, leaseExpiresAt: null, lastError: null, nextAttemptAt: null },
      });
      if (!saved.count) throw new OperationPendingError("Financial operation lease lost; result will be reconciled");
      await provider.apply?.(tx, result);
    }, { timeout: 15000 });
    return result;
  } catch (error) {
    // Includes DB errors after provider success. Never turn uncertainty into a
    // terminal failure or free the reserved refund balance.
    await prisma.financialOperation.updateMany({
      where: { id: claimed.id, leaseToken: token },
      data: { state: error instanceof UncertainOutcomeError ? "REVIEW" : "RETRY", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + 30000), lastError: String(error).slice(0, 1000) },
    });
    throw error;
  }
}
