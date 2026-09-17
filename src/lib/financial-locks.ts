import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { financialProjection } from "@/lib/financial-projection";

export const eventFence = new AsyncLocalStorage<{ id: string; token: string }>();

export async function assertEventFence(tx: Prisma.TransactionClient) {
  const fence = eventFence.getStore();
  if (!fence) return;
  await tx.$queryRaw`SELECT financial_guard_xact(${'event:' + fence.id})`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StripeEvent" WHERE "id" = ${fence.id}
      AND "leaseToken" = ${fence.token} AND "status" = 'PROCESSING'
      AND "processingStartedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 minutes' FOR UPDATE`;
  if (!rows.length) throw new Error("Stripe event lease lost");
}

// Lock order everywhere: event (if present), vehicle, reservation, operation.
// READ COMMITTED ensures reads after waiting on the lock see the winning writer.
export async function lockReservation(tx: Prisma.TransactionClient, id: string) {
  await assertEventFence(tx);
  const row = await tx.reservation.findUniqueOrThrow({ where: { id }, select: { vehicleId: true } });
  await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + row.vehicleId})`;
  await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${row.vehicleId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${id} FOR UPDATE`;
  return tx.reservation.findUniqueOrThrow({ where: { id } });
}

export function withReservationLock<T>(id: string, run: (tx: Prisma.TransactionClient) => Promise<T>, db: PrismaClient = prisma) {
  return db.$transaction(async tx => {
    await lockReservation(tx, id);
    return run(tx);
  }, { maxWait: 15000, timeout: 15000 });
}

// Mandatory even for emergency state transitions. Caller holds the reservation
// lock, shared with refund reservation and deposit/cancellation projections.
export async function assertFinancialTripStart(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { payments: true, refunds: true, deposit: { include: { operation: true } } } });
  const projection = financialProjection(r);
  if (r.financialDisposition !== "OPEN" || !projection.moneyAvailable) throw new Error("Financial state does not permit trip start");
  if (!projection.depositValid) throw new Error("Valid required deposit authorization missing");
}
