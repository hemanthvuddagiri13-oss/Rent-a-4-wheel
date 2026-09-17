import type { Prisma } from "@prisma/client";
import { prepareOperation } from "@/lib/financial-operations";
// Caller owns the reservation lock. Persist compensation in the same commit as
// the provider observation/terminal transition, including superseded generations.
export async function planDepositRelease(tx: Prisma.TransactionClient, reservationId: string, intentId: string) {
  return prepareOperation(tx, { key: `deposit-release:${intentId}`, kind: "DEPOSIT_RELEASE", reservationId, payload: { intentId } });
}
export async function planAllDepositReleases(tx: Prisma.TransactionClient, reservationId: string) {
  const ops = await tx.financialOperation.findMany({ where: { reservationId, kind: "DEPOSIT", providerId: { not: null } } });
  for (const op of ops) await planDepositRelease(tx, reservationId, op.providerId!);
}
