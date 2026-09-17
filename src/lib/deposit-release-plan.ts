import type { Prisma } from "@prisma/client";
import { prepareOperation } from "@/lib/financial-operations";
// Caller owns the reservation lock. Persist compensation in the same commit as
// the provider observation/terminal transition, including superseded generations.
export async function planDepositRelease(tx: Prisma.TransactionClient, reservationId: string, intentId: string) {
  const release = await prepareOperation(tx, { key: `deposit-release:${intentId}`, kind: "DEPOSIT_RELEASE", reservationId, payload: { intentId } });
  // A cancellation should not wait out an earlier transient retry's backoff.
  // Leave active leases and operator-review decisions intact.
  await tx.financialOperation.updateMany({ where: { id: release.id, state: { in: ["READY", "RETRY", "POLL"] }, nextAttemptAt: { gt: new Date() }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] }, data: { nextAttemptAt: new Date() } });
  const original = await tx.financialOperation.findFirst({ where: { reservationId, kind: "DEPOSIT", providerId: intentId } });
  if (release.generation === null && original?.generation !== null && original?.generation !== undefined) return tx.financialOperation.update({ where: { id: release.id }, data: { generation: original.generation } });
  return tx.financialOperation.findUniqueOrThrow({ where: { id: release.id } });
}
export async function planAllDepositReleases(tx: Prisma.TransactionClient, reservationId: string) {
  const ops = await tx.financialOperation.findMany({ where: { reservationId, kind: "DEPOSIT", providerId: { not: null } } });
  for (const op of ops) await planDepositRelease(tx, reservationId, op.providerId!);
  const deposit = await tx.securityDeposit.findUnique({ where: { reservationId } });
  if (deposit?.stripePaymentIntentId && !deposit.releasedAt && !["canceled", "succeeded"].includes(deposit.stripeStatus ?? "")) await planDepositRelease(tx, reservationId, deposit.stripePaymentIntentId);
}
