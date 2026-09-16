import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { queueNotification } from "@/lib/notifications";
import type { NotificationType } from "@prisma/client";

export type OutboxNotificationPayload = {
  userId?: string;
  reservationId?: string;
  type: NotificationType;
  extra?: Record<string, unknown>;
};

/**
 * Enqueues a notification (or other required post-payment action) as part
 * of the SAME database transaction as the state change that requires it —
 * the transactional-outbox pattern. If the transaction rolls back, the
 * message is never enqueued; if it commits, the message is durably queued
 * for `processOutboxOnce` to dispatch, even if the process crashes
 * immediately after commit. This replaces calling `queueNotification`
 * directly after a transaction (which can silently lose the notification
 * if the process dies between the commit and that call).
 */
export async function enqueueOutboxNotification(
  tx: Prisma.TransactionClient,
  payload: OutboxNotificationPayload
): Promise<void> {
  await tx.outboxMessage.create({
    data: { type: "notification", payload: payload as unknown as Prisma.InputJsonValue },
  });
}

const MAX_ATTEMPTS = 5;
const BACKOFF_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];

function nextRetryDelayMs(attempts: number): number {
  return BACKOFF_SCHEDULE_MS[Math.min(attempts, BACKOFF_SCHEDULE_MS.length - 1)]!;
}

/**
 * Dispatches up to `limit` pending outbox messages. Safe to call
 * repeatedly/concurrently (each message is claimed via a conditional
 * update before being processed) and safe to retry on failure — a
 * message that fails is rescheduled with backoff, up to MAX_ATTEMPTS,
 * after which it's left FAILED for manual inspection rather than retried
 * forever.
 */
export async function processOutboxOnce(limit = 50): Promise<{ processed: number; failed: number }> {
  const now = new Date();
  const candidates = await prisma.outboxMessage.findMany({
    where: { status: "PENDING", OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let processed = 0;
  let failed = 0;

  for (const message of candidates) {
    const claim = await prisma.outboxMessage.updateMany({
      where: { id: message.id, status: "PENDING" },
      data: { attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue; // claimed by a concurrent dispatcher

    try {
      await dispatchOutboxMessage(message.type, message.payload as unknown);
      await prisma.outboxMessage.update({ where: { id: message.id }, data: { status: "SENT", processedAt: new Date() } });
      processed += 1;
    } catch (err) {
      const attempts = message.attempts + 1;
      const isExhausted = attempts >= MAX_ATTEMPTS;
      await prisma.outboxMessage.update({
        where: { id: message.id },
        data: {
          status: isExhausted ? "FAILED" : "PENDING",
          lastError: err instanceof Error ? err.message : String(err),
          nextRetryAt: isExhausted ? null : new Date(Date.now() + nextRetryDelayMs(attempts)),
        },
      });
      failed += 1;
    }
  }

  return { processed, failed };
}

async function dispatchOutboxMessage(type: string, payload: unknown): Promise<void> {
  if (type === "notification") {
    const p = payload as OutboxNotificationPayload;
    await queueNotification({ userId: p.userId, reservationId: p.reservationId, type: p.type, extra: p.extra });
    return;
  }
  throw new Error(`Unknown outbox message type: ${type}`);
}
