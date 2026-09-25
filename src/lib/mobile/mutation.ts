import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { fingerprint, json } from "@/lib/financial-operations";
import { authenticateMobile, MobileError, MobileNonCommit } from "./auth";
import { ZodError } from "zod";
import { MarketplaceError } from "@/lib/marketplace";
import { HoldError } from "@/lib/checkout-hold";
import { mutationOperations, type RecoverableOperation } from "../../../packages/mobile-client/src/mutation-operations";

const rejectionOperations = new Set(["message.send", "case.reply", "case.open", "reservation.hold"]);
type Rejection = { mobileRejectedV1: { status: 400 | 409 } };
function rejected(value: unknown): value is Rejection {
  const status = (value as Rejection | null)?.mobileRejectedV1?.status;
  return status === 400 || status === 409;
}
function fenced(value: unknown) { return (value as { mobileFencedV1?: unknown } | null)?.mobileFencedV1 === true; }
/** Resolve only the authenticated actor's key. No resource data or result is
 * disclosed, and no domain action is executed. The original mutation lock fences
 * requests still in flight: either their receipt wins, or this terminal fence wins. */
export async function resolveMobileMutation(req: Request, operation: RecoverableOperation, key: string, db: PrismaClient = prisma) {
  const actor = await authenticateMobile(req.headers, db);
  const name = mutationOperations[operation];
  const id = createHash('sha256').update(JSON.stringify([actor.userId, name, key])).digest('hex');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mobile-mutation:" + id},0))::text`;
    await authenticateMobile(req.headers, tx, false);
    const prior = await tx.mobileMutation.findUnique({ where: { id } });
    if (prior) return { outcome: rejected(prior.result) || fenced(prior.result) ? 'NOT_COMMITTED' as const : 'COMMITTED' as const, idempotencyKey: key };
    await tx.mobileMutation.create({ data: { id, userId: actor.userId, operation: name, fingerprint: 'terminal-fence-v1', result: { mobileFencedV1: true } } });
    return { outcome: 'NOT_COMMITTED' as const, idempotencyKey: key };
  }, { maxWait: 15000, timeout: 20000 });
}

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
  let commandError: unknown;
  const unwrap = (result: T | Rejection): T => { if (rejected(result)) throw new MobileNonCommit(result.mobileRejectedV1.status, key); return result; };
  try { return unwrap(await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mobile-mutation:" + id},0))::text`;
    // Read current credentials again without holding a device-row write lock
    // across financial/domain locks. Refresh/logout lock user then device;
    // case commands lock reservation then user, so a nested touch would invert
    // those orders. The outer authentication already records last use by CAS.
    await authenticateMobile(req.headers, tx, false);
    // Recheck tenant access even when returning a previously committed receipt.
    await authorize(tx, actor.userId);
    const prior = await tx.mobileMutation.findUnique({ where: { id } });
    if (prior) {
      if (fenced(prior.result)) throw new MobileNonCommit(409, key);
      if (prior.fingerprint !== hash) throw new MobileError("CONFLICT", 409);
      return prior.result as T;
    }
    let result: T;
    try { result = await run(tx, actor.userId); } catch (error) { commandError = error; throw error; }
    await tx.mobileMutation.create({ data: { id, userId: actor.userId, operation, fingerprint: hash, result: json(result) } });
    return result;
  }, { maxWait: 15000, timeout: 20000 })); }
  catch (error) {
    // Only an allowlisted command rejection after completed transaction rollback
    // qualifies. Auth, prior-key conflicts, commit/transport/database failures do not.
    const status = error instanceof ZodError ? 400 : error instanceof MobileError || error instanceof MarketplaceError || error instanceof HoldError ? error.status : 0;
    if (error !== commandError || !rejectionOperations.has(operation) || (status !== 400 && status !== 409)) throw error;
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mobile-mutation:" + id},0))::text`;
      await authenticateMobile(req.headers, tx, false);
      await authorize(tx, actor.userId);
      // A competing retry may have committed while the failed transaction rolled
      // back. Never declare that receipt uncommitted or overwrite it.
      const prior = await tx.mobileMutation.findUnique({ where: { id } });
      if (prior) {
        if (fenced(prior.result)) throw new MobileNonCommit(409, key);
        if (prior.fingerprint !== hash) throw new MobileError("CONFLICT", 409);
        return prior.result as T | Rejection;
      }
      const terminal: Rejection = { mobileRejectedV1: { status } };
      await tx.mobileMutation.create({ data: { id, userId: actor.userId, operation, fingerprint: hash, result: terminal } });
      return terminal;
    }, { maxWait: 15000, timeout: 20000 });
    return unwrap(result);
  }
}
