import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { fingerprint, json } from "@/lib/financial-operations";
import { authenticateMobile, MobileError } from "./auth";

/** Only safe, allowlisted results (normally resource IDs) belong in receipts.
 * Provider work must use the domain's durable outbox/operation, never run an
 * irreversible external side effect in this transaction callback. */
export async function mobileMutation<T extends Prisma.InputJsonObject>(req: Request, operation: string, input: unknown,
  authorize: (tx: Prisma.TransactionClient, userId: string) => Promise<void>,
  run: (tx: Prisma.TransactionClient, userId: string) => Promise<T>, db: PrismaClient = prisma): Promise<T> {
  const actor = await authenticateMobile(req.headers, db);
  const key = req.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new MobileError("INVALID_REQUEST", 400);
  const id = createHash("sha256").update(JSON.stringify([actor.userId, operation, key])).digest("hex"), hash = fingerprint(input);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mobile-mutation:" + id},0))::text`;
    await authenticateMobile(req.headers, tx);
    // Recheck tenant access even when returning a previously committed receipt.
    await authorize(tx, actor.userId);
    const prior = await tx.mobileMutation.findUnique({ where: { id } });
    if (prior) {
      if (prior.fingerprint !== hash) throw new MobileError("CONFLICT", 409);
      return prior.result as T;
    }
    const result = await run(tx, actor.userId);
    await tx.mobileMutation.create({ data: { id, userId: actor.userId, operation, fingerprint: hash, result: json(result) } });
    return result;
  }, { maxWait: 15000, timeout: 20000 });
}
