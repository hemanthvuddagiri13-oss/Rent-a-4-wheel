import { randomUUID } from "crypto";
import { Prisma, StripeEventStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// How long a PROCESSING event is trusted to still genuinely be in
// progress before it's considered abandoned (e.g. the process handling it
// crashed) and safe to reclaim.
const STALE_PROCESSING_MS = 2 * 60 * 1000;

const BACKOFF_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];

function nextRetryDelayMs(attemptCount: number): number {
  return BACKOFF_SCHEDULE_MS[Math.min(attemptCount, BACKOFF_SCHEDULE_MS.length - 1)]!;
}

export type ClaimResult =
  | { shouldProcess: true; eventRecordId: string; leaseToken: string }
  | { shouldProcess: false; reason: "already_processed" | "in_progress_elsewhere" };

/**
 * Claims a Stripe event for processing, atomically, before any side
 * effect runs:
 *  - PROCESSED already -> no-op (`already_processed`).
 *  - PROCESSING and not stale -> another request is handling it right now;
 *    don't double-process (`in_progress_elsewhere`).
 *  - RECEIVED, FAILED, or PROCESSING-but-stale -> claimed: flips to
 *    PROCESSING, stamps `processingStartedAt`, increments `attemptCount`,
 *    and mints a fresh `leaseToken`.
 *
 * The claim itself is a compare-and-swap `updateMany` so two concurrent
 * webhook deliveries (or a webhook delivery racing the recovery worker)
 * for the same event can't both win it. The returned `leaseToken` must be
 * passed to `markStripeEventProcessed`/`markStripeEventFailed` — those
 * calls are themselves conditional on the token still matching, so a
 * worker that reclaimed this event out from under a stale one (minting a
 * new token) can never have its outcome overwritten by the original,
 * merely-slow worker finally finishing.
 */
export async function claimStripeEventForProcessing(params: {
  stripeEventId: string;
  type: string;
  payload: Prisma.InputJsonValue;
}): Promise<ClaimResult> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS);
  const leaseToken = randomUUID();

  let recordId: string;
  try {
    const created = await prisma.stripeEvent.create({
      data: {
        stripeEventId: params.stripeEventId,
        type: params.type,
        payload: params.payload,
        status: StripeEventStatus.RECEIVED,
        receivedAt: now,
      },
    });
    recordId = created.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    const existing = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: params.stripeEventId } });
    if (existing.status === StripeEventStatus.PROCESSED) {
      return { shouldProcess: false, reason: "already_processed" };
    }
    if (existing.status === StripeEventStatus.PROCESSING && existing.processingStartedAt! > staleThreshold) {
      return { shouldProcess: false, reason: "in_progress_elsewhere" };
    }
    recordId = existing.id;
  }

  return claimExistingRecord(recordId, leaseToken, staleThreshold);
}

async function claimExistingRecord(recordId: string, leaseToken: string, staleThreshold: Date): Promise<ClaimResult> {
  const claim = await prisma.stripeEvent.updateMany({
    where: {
      id: recordId,
      OR: [
        { status: { in: [StripeEventStatus.RECEIVED, StripeEventStatus.FAILED] } },
        { status: StripeEventStatus.PROCESSING, processingStartedAt: { lt: staleThreshold } },
      ],
    },
    data: { status: StripeEventStatus.PROCESSING, processingStartedAt: new Date(), attemptCount: { increment: 1 }, leaseToken },
  });

  if (claim.count !== 1) {
    const reloaded = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: recordId } });
    return {
      shouldProcess: false,
      reason: reloaded.status === StripeEventStatus.PROCESSED ? "already_processed" : "in_progress_elsewhere",
    };
  }

  return { shouldProcess: true, eventRecordId: recordId, leaseToken };
}

/**
 * Re-claims events sitting in RECEIVED, FAILED (past `nextRetryAt`), or
 * stale PROCESSING for the scheduled recovery worker (see
 * /api/cron/reconcile-stripe-events). Returns the claimed records (with
 * their stored `payload` so the worker can replay them without
 * re-fetching from Stripe) plus each one's fresh lease token.
 */
export async function claimRecoverableStripeEvents(limit = 25): Promise<
  Array<{ eventRecordId: string; stripeEventId: string; type: string; payload: unknown; leaseToken: string }>
> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS);

  const candidates = await prisma.stripeEvent.findMany({
    where: {
      OR: [
        { status: StripeEventStatus.RECEIVED },
        { status: StripeEventStatus.FAILED, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        { status: StripeEventStatus.PROCESSING, processingStartedAt: { lt: staleThreshold } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });

  const claimed: Array<{ eventRecordId: string; stripeEventId: string; type: string; payload: unknown; leaseToken: string }> = [];
  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const result = await claimExistingRecord(candidate.id, leaseToken, staleThreshold);
    if (result.shouldProcess) {
      claimed.push({
        eventRecordId: candidate.id,
        stripeEventId: candidate.stripeEventId,
        type: candidate.type,
        payload: candidate.payload,
        leaseToken,
      });
    }
  }
  return claimed;
}

/**
 * Marks an event PROCESSED — but only if `leaseToken` still matches the
 * row's current token. If a recovery worker has since reclaimed this
 * event (because this worker was slow enough to be considered stale),
 * this is a safe no-op rather than an overwrite of the newer worker's
 * outcome.
 */
export async function markStripeEventProcessed(eventRecordId: string, leaseToken: string): Promise<void> {
  await prisma.stripeEvent.updateMany({
    where: { id: eventRecordId, leaseToken },
    data: { status: StripeEventStatus.PROCESSED, processedAt: new Date() },
  });
}

export async function markStripeEventFailed(eventRecordId: string, leaseToken: string, error: unknown): Promise<void> {
  const record = await prisma.stripeEvent.findUnique({ where: { id: eventRecordId } });
  if (!record || record.leaseToken !== leaseToken) return; // fenced out by a newer claim
  const message = error instanceof Error ? error.message : String(error);
  await prisma.stripeEvent.updateMany({
    where: { id: eventRecordId, leaseToken },
    data: {
      status: StripeEventStatus.FAILED,
      lastError: message.slice(0, 4000),
      nextRetryAt: new Date(Date.now() + nextRetryDelayMs(record.attemptCount)),
    },
  });
}
