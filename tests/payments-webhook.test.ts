import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const createPaymentIntent = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent } },
  isStripeConfigured: () => true,
}));

const { handlePaymentIntentSucceeded, handlePaymentIntentFailed } = await import("@/lib/stripe-webhook-handlers");
const { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } =
  await import("./helpers/factories");

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterEach(() => {
  createPaymentIntent.mockReset();
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
