import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { prisma as appPrisma } from "@/lib/prisma";

const createPaymentIntent = vi.fn();
const createRefund = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent }, refunds: { create: createRefund } },
  isStripeConfigured: () => true,
}));

const { handlePaymentIntentSucceeded, handlePaymentIntentFailed } = await import("@/lib/stripe-webhook-handlers");
const { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } =
  await import("./helpers/factories");

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterEach(() => {
  createPaymentIntent.mockReset();
  createRefund.mockReset();
});

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function setupAwaitingPaymentReservation(depositCents: number) {
  const vehicle = await createTestVehicle({ securityDepositCents: depositCents });
  const customer = await createTestCustomer();
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id);

  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date("2029-01-10T10:00:00Z"),
    returnAt: new Date("2029-01-13T10:00:00Z"),
    status: "AWAITING_PAYMENT",
    depositCents,
  });

  if (depositCents > 0) {
    await prisma.securityDeposit.create({
      data: { reservationId: reservation.id, amountCents: depositCents, status: "REQUIRES_PAYMENT" },
    });
  }

  const payment = await prisma.payment.create({
    data: {
      reservationId: reservation.id,
      type: "RENTAL",
      status: "REQUIRES_PAYMENT",
      amountCents: 15000,
      stripePaymentIntentId: `pi_test_${reservation.id}`,
    },
  });

  return { reservation, payment };
}

function fakeIntent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    payment_method: "pm_test_123",
    customer: "cus_test_123",
    ...overrides,
  } as never;
}

describe("handlePaymentIntentSucceeded — payment/deposit gating", () => {
  it("confirms the reservation (and chains to DOCUMENTS_REQUIRED) when no deposit is required", async () => {
    const { reservation, payment } = await setupAwaitingPaymentReservation(0);

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("SUCCEEDED");
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("confirms the reservation when the deposit authorization succeeds", async () => {
    const { reservation, payment } = await setupAwaitingPaymentReservation(30000);
    createPaymentIntent.mockResolvedValueOnce({ id: `pi_deposit_success_${reservation.id}` });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
    expect(reloaded.deposit?.status).toBe("SUCCEEDED");
  });

  it("does NOT confirm the reservation when the rental payment succeeds but deposit authorization fails", async () => {
    createPaymentIntent.mockRejectedValueOnce(new Error("Your card was declined."));
    const { reservation, payment } = await setupAwaitingPaymentReservation(30000);

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { deposit: true } });
    // Critical correctness rule: rental payment alone is not sufficient —
    // the reservation must remain unconfirmed when a required deposit
    // authorization fails.
    expect(reloaded.status).toBe("PAYMENT_FAILED");
    expect(reloaded.deposit?.status).toBe("FAILED");

    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    // The rental charge itself did succeed — that's tracked independently
    // of the reservation's overall confirmation state.
    expect(reloadedPayment.status).toBe("SUCCEEDED");
  });

  it("is idempotent: calling it again after the payment already succeeded is a no-op", async () => {
    const { reservation, payment } = await setupAwaitingPaymentReservation(0);
    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    // Second delivery of the same event (e.g. a webhook retry that reached
    // this handler despite the route-level StripeEvent ledger — belt and
    // suspenders) must not re-run any side effects or throw.
    await expect(handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!))).resolves.toBeUndefined();

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
  });

  it("handles an out-of-order payment_intent.payment_failed arriving after success without downgrading a confirmed reservation", async () => {
    const { reservation, payment } = await setupAwaitingPaymentReservation(0);
    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    // A late/out-of-order failure event for the same PaymentIntent must not
    // undo the confirmation that already happened.
    await handlePaymentIntentFailed(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
  });
});

describe("handlePaymentIntentFailed", () => {
  it("moves an AWAITING_PAYMENT reservation to PAYMENT_FAILED", async () => {
    const { reservation, payment } = await setupAwaitingPaymentReservation(0);

    await handlePaymentIntentFailed(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("PAYMENT_FAILED");
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("FAILED");
  });
});

describe("Stripe webhook event idempotency ledger", () => {
  it("rejects a duplicate stripeEventId with a unique-constraint violation", async () => {
    const eventId = `evt_test_${Date.now()}`;
    await prisma.stripeEvent.create({ data: { stripeEventId: eventId, type: "payment_intent.succeeded" } });

    await expect(
      prisma.stripeEvent.create({ data: { stripeEventId: eventId, type: "payment_intent.succeeded" } })
    ).rejects.toThrow();

    await prisma.stripeEvent.deleteMany({ where: { stripeEventId: eventId } });
  });
});

describe("temporary Stripe failure during deposit authorization", () => {
  it("propagates the error instead of recording a permanent deposit decline, leaving the reservation retryable", async () => {
    const { reservation, payment } = await setupAwaitingPaymentReservation(30000);
    createPaymentIntent.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: "network blip" }));

    await expect(handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!))).rejects.toThrow(
      "network blip"
    );

    // Must NOT have been recorded as a permanent decline — a transient
    // Stripe-side failure has to come back as retryable, not
    // PAYMENT_FAILED (which would be indistinguishable from a real
    // card decline to the customer).
    const reloadedReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloadedReservation.status).toBe("AWAITING_PAYMENT");
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("REQUIRES_PAYMENT");

    // A subsequent retry (the network blip having cleared) succeeds normally.
    createPaymentIntent.mockResolvedValueOnce({ id: `pi_deposit_retry_${reservation.id}` });
    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));
    const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(finalReservation.status).toBe("DOCUMENTS_REQUIRED");
  });
});

describe("database failure after a successful Stripe call is never swallowed", () => {
  it("propagates a DB persistence failure instead of silently returning success", async () => {
    const { payment } = await setupAwaitingPaymentReservation(0);

    // Spy on the exact same `prisma` singleton stripe-webhook-handlers.ts
    // imports from "@/lib/prisma" (not the standalone client
    // tests/helpers/factories.ts creates for test setup/teardown) — only
    // that instance is actually called by the code under test.
    const spy = vi
      .spyOn(appPrisma, "$transaction")
      .mockImplementationOnce(() => Promise.reject(new Error("simulated DB outage")));

    try {
      await expect(handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!))).rejects.toThrow(
        "simulated DB outage"
      );
    } finally {
      spy.mockRestore();
    }

    // Payment must still show as unresolved — nothing was silently marked
    // successful despite the persistence failure.
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("REQUIRES_PAYMENT");
  });
});

describe("late payment reconciliation — hold expired mid-payment", () => {
  it("auto-resolves by reopening the same reservation when the dates are still available", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-06-10T10:00:00Z"),
      returnAt: new Date("2029-06-13T10:00:00Z"),
      status: "EXPIRED", // the hold expired while the PaymentIntent was still confirming
    });
    const payment = await prisma.payment.create({
      data: {
        reservationId: reservation.id,
        type: "RENTAL",
        status: "REQUIRES_PAYMENT",
        amountCents: 15000,
        stripePaymentIntentId: `pi_test_late_${reservation.id}`,
      },
    });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    // The customer must not silently lose money: the exact same
    // reservation is confirmed rather than left expired with a captured
    // charge and nothing to show for it.
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");

    const reconciliation = await prisma.paymentReconciliation.findFirst({ where: { reservationId: reservation.id } });
    expect(reconciliation?.reason).toBe("PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED");
    expect(reconciliation?.status).toBe("AUTO_RESOLVED");
  });

  it("automatically refunds the charge and flags for review when someone else already has the dates", async () => {
    const vehicle = await createTestVehicle();
    const customerA = await createTestCustomer();
    const customerB = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customerA.id, customerB.id);

    const pickupAt = new Date("2029-07-10T10:00:00Z");
    const returnAt = new Date("2029-07-13T10:00:00Z");

    const expiredReservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customerA.id,
      pickupAt,
      returnAt,
      status: "EXPIRED",
    });
    // Someone else confirmed the same dates before A's late payment landed.
    await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customerB.id,
      pickupAt,
      returnAt,
      status: "CONFIRMED",
    });

    const payment = await prisma.payment.create({
      data: {
        reservationId: expiredReservation.id,
        type: "RENTAL",
        status: "REQUIRES_PAYMENT",
        amountCents: 15000,
        stripePaymentIntentId: `pi_test_late_unavailable_${expiredReservation.id}`,
      },
    });
    createRefund.mockResolvedValueOnce({ id: `re_test_${expiredReservation.id}` });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    // The now-doubly-booked reservation must NOT be resurrected — it stays
    // exactly as it was (EXPIRED, historically accurate).
    const reloadedReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: expiredReservation.id } });
    expect(reloadedReservation.status).toBe("EXPIRED");

    expect(createRefund).toHaveBeenCalledOnce();
    const refundRow = await prisma.refund.findFirst({ where: { reservationId: expiredReservation.id } });
    expect(refundRow?.status).toBe("SUCCEEDED");

    const reconciliation = await prisma.paymentReconciliation.findFirst({ where: { reservationId: expiredReservation.id } });
    expect(reconciliation?.reason).toBe("PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED");
    expect(reconciliation?.status).toBe("REFUNDED");
  });
});
