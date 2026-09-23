import type { Prisma, PrismaClient } from "@prisma/client";

export type DomainDatabase = PrismaClient | Prisma.TransactionClient;
/** Compose an existing domain write with its caller's durable intent. Existing
 * web callers still open the same transaction; native callers commit the write
 * and idempotency receipt together. Never emulate a nested transaction. */
export function domainTransaction<T>(db: DomainDatabase, run: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number }) {
  return "$transaction" in db ? db.$transaction(run, options) : run(db);
}
