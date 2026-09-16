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
  | { shouldProcess: true; eventRecordId: string }
  | { shouldProcess: false; reason: "already_processed" | "in_progress_elsewhere" };

/**
 * Claims a Stripe event for processing, atomically, before any side
 * effect runs:
 *  - PROCESSED already -> no-op (`already_processed`).
 *  - PROCESSING and not stale -> another request is handling it right now;
 *    don't double-process (`in_progress_elsewhere`).
 *  - RECEIVED, FAILED, or PROCESSING-but-stale -> claimed: flips to
 *    PROCESSING, stamps `processingStartedAt`, increments `attemptCount`.
 *
 * The claim itself is a compare-and-swap `updateMany` so two concurrent
 * webhook deliveries for the same event can't both win it.
 */
export async function claimStripeEventForProcessing(params: {
  stripeEventId: string;
  type: string;
  payload: Prisma.InputJsonValue;
}): Promise<ClaimResult> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS);

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

  const claim = await prisma.stripeEvent.updateMany({
    where: {
      id: recordId,
      OR: [
        { status: { in: [StripeEventStatus.RECEIVED, StripeEventStatus.FAILED] } },
        { status: StripeEventStatus.PROCESSING, processingStartedAt: { lt: staleThreshold } },
      ],
    },
    data: { status: StripeEventStatus.PROCESSING, processingStartedAt: now, attemptCount: { increment: 1 } },
  });

  if (claim.count !== 1) {
    // Lost the race to a concurrent claim, or it reached PROCESSED between
    // our read and this update — either way, not ours to process.
    const reloaded = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: recordId } });
    return {
      shouldProcess: false,
      reason: reloaded.status === StripeEventStatus.PROCESSED ? "already_processed" : "in_progress_elsewhere",
    };
  }

  return { shouldProcess: true, eventRecordId: recordId };
}

export async function markStripeEventProcessed(eventRecordId: string): Promise<void> {
  await prisma.stripeEvent.update({
    where: { id: eventRecordId },
    data: { status: StripeEventStatus.PROCESSED, processedAt: new Date() },
  });
}

export async function markStripeEventFailed(eventRecordId: string, error: unknown): Promise<void> {
  const record = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: eventRecordId } });
  const message = error instanceof Error ? error.message : String(error);
  await prisma.stripeEvent.update({
    where: { id: eventRecordId },
    data: {
      status: StripeEventStatus.FAILED,
      lastError: message.slice(0, 4000),
      nextRetryAt: new Date(Date.now() + nextRetryDelayMs(record.attemptCount)),
    },
  });
}
