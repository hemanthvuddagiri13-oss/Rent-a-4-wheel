import { afterAll, describe, expect, it } from "vitest";
import {
  claimStripeEventForProcessing,
  markStripeEventProcessed,
  markStripeEventFailed,
  type ClaimResult,
} from "@/lib/stripe-event-ledger";
import { prisma } from "./helpers/factories";

function assertClaimed(claim: ClaimResult): asserts claim is { shouldProcess: true; eventRecordId: string } {
  if (!claim.shouldProcess) throw new Error("Expected the event to be claimed for processing.");
}

const cleanupIds: string[] = [];

afterAll(async () => {
  await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { in: cleanupIds } } });
  await prisma.$disconnect();
});

function uniqueEventId(label: string) {
  const id = `evt_test_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  cleanupIds.push(id);
  return id;
}

describe("Stripe event processing state machine", () => {
  it("claims a brand-new event as RECEIVED -> PROCESSING", async () => {
    const stripeEventId = uniqueEventId("new");
    const claim = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(claim.shouldProcess).toBe(true);

    const record = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId } });
    expect(record.status).toBe("PROCESSING");
    expect(record.attemptCount).toBe(1);
    expect(record.processingStartedAt).not.toBeNull();
  });

  it("a duplicate delivery of an already-PROCESSED event is a no-op", async () => {
    const stripeEventId = uniqueEventId("processed");
    const first = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(first.shouldProcess).toBe(true);
    assertClaimed(first);
    await markStripeEventProcessed(first.eventRecordId);

    const duplicate = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(duplicate.shouldProcess).toBe(false);
    if (!duplicate.shouldProcess) expect(duplicate.reason).toBe("already_processed");
  });

  it("webhook failure followed by retry: a FAILED event is safely re-claimable and can reach PROCESSED", async () => {
    const stripeEventId = uniqueEventId("failed_retry");
    const first = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(first.shouldProcess).toBe(true);
    assertClaimed(first);
    await markStripeEventFailed(first.eventRecordId, new Error("simulated transient DB failure"));

    const failedRecord = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId } });
    expect(failedRecord.status).toBe("FAILED");
    expect(failedRecord.lastError).toContain("simulated transient DB failure");
    expect(failedRecord.nextRetryAt).not.toBeNull();

    // Simulated retry (a second webhook delivery, or a manual replay).
    const retry = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(retry.shouldProcess).toBe(true);
    assertClaimed(retry);
    await markStripeEventProcessed(retry.eventRecordId);

    const finalRecord = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId } });
    expect(finalRecord.status).toBe("PROCESSED");
    expect(finalRecord.attemptCount).toBe(2);
  });

  it("a fresh (non-stale) PROCESSING event refuses a concurrent duplicate claim", async () => {
    const stripeEventId = uniqueEventId("in_progress");
    const first = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(first.shouldProcess).toBe(true);
    // Do not mark it processed/failed — simulate it still being handled.

    const concurrent = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(concurrent.shouldProcess).toBe(false);
    if (!concurrent.shouldProcess) expect(concurrent.reason).toBe("in_progress_elsewhere");
  });

  it("a stale PROCESSING event (abandoned mid-processing) is recoverable", async () => {
    const stripeEventId = uniqueEventId("stale");
    const first = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(first.shouldProcess).toBe(true);
    assertClaimed(first);

    // Simulate the claim having happened long enough ago to be considered
    // abandoned (e.g. the process handling it crashed).
    await prisma.stripeEvent.update({
      where: { id: first.eventRecordId },
      data: { processingStartedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const recovered = await claimStripeEventForProcessing({ stripeEventId, type: "payment_intent.succeeded", payload: {} });
    expect(recovered.shouldProcess).toBe(true);

    const record = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId } });
    expect(record.attemptCount).toBe(2);
  });
});
