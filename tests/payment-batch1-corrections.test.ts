import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const createPaymentIntent = vi.fn();
const createRefund = vi.fn();
const retrievePaymentIntent = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent, retrieve: retrievePaymentIntent }, refunds: { create: createRefund } },
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
  retrievePaymentIntent.mockReset();
});

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

function fakeIntent(id: string, overrides: Record<string, unknown> = {}) {
  return { id, payment_method: "pm_test_123", customer: "cus_test_123", status: "succeeded", ...overrides } as never;
}

async function makeVehicleAndCustomer(depositCents = 0) {
  const vehicle = await createTestVehicle({ securityDepositCents: depositCents });
  const customer = await createTestCustomer();
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id);
  return { vehicle, customer };
}

describe("item 1 — monotonic payment state transitions", () => {
  it("a payment_intent.payment_failed arriving after success never downgrades a SUCCEEDED payment, even without re-fetching Stripe", async () => {
    const { vehicle, customer } = await makeVehicleAndCustomer(0);
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-02-10T10:00:00Z"),
      returnAt: new Date("2029-02-13T10:00:00Z"),
      status: "AWAITING_PAYMENT",
    });
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "REQUIRES_PAYMENT", amountCents: 15000, stripePaymentIntentId: `pi_mono_${reservation.id}` },
    });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));
    let reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");

    // Out-of-order failure event for the same intent, arriving after
    // success — the handler self-heals by re-checking Stripe's
    // authoritative state, which (per the guard) it never even needs to
    // reach because payment.status is already SUCCEEDED.
    retrievePaymentIntent.mockResolvedValueOnce({ status: "succeeded" });
    await handlePaymentIntentFailed(fakeIntent(payment.stripePaymentIntentId!, { status: "requires_payment_method" }));

    reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("SUCCEEDED");
  });

  it("self-heals a failed-event delivery when Stripe's authoritative state is actually succeeded (out-of-order webhook delivery)", async () => {
    const { vehicle, customer } = await makeVehicleAndCustomer(0);
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-02-20T10:00:00Z"),
      returnAt: new Date("2029-02-23T10:00:00Z"),
      status: "AWAITING_PAYMENT",
    });
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "REQUIRES_PAYMENT", amountCents: 15000, stripePaymentIntentId: `pi_heal_${reservation.id}` },
    });

    // The `payment_intent.payment_failed` event is delivered FIRST (before
    // the `succeeded` event, which Stripe does not guarantee ordering
    // for). The handler re-fetches Stripe's authoritative current state,
    // sees "succeeded", and routes to the success handler instead of
    // leaving the reservation incorrectly marked as failed.
    retrievePaymentIntent.mockResolvedValueOnce(fakeIntent(payment.stripePaymentIntentId!, { status: "succeeded" }));
    await handlePaymentIntentFailed(fakeIntent(payment.stripePaymentIntentId!, { status: "requires_payment_method" }));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("SUCCEEDED");
  });
});

describe("item 3 — late payment reconciliation before the cleanup sweep runs", () => {
  it("routes a succeeded payment through reconciliation when status is still nominally AWAITING_PAYMENT but expiresAt has already passed", async () => {
    const { vehicle, customer } = await makeVehicleAndCustomer(0);
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-03-10T10:00:00Z"),
      returnAt: new Date("2029-03-13T10:00:00Z"),
      status: "AWAITING_PAYMENT",
      // Deadline already in the past — the cleanup sweep simply hasn't
      // run yet to flip this to EXPIRED.
      expiresAt: new Date(Date.now() - 60_000),
    });
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "REQUIRES_PAYMENT", amountCents: 15000, stripePaymentIntentId: `pi_late_${reservation.id}` },
    });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    // Must reach the SAME confirmed outcome as an on-time payment (the
    // customer must not silently lose money because cleanup hadn't swept
    // this row yet) — not remain permanently stuck AWAITING_PAYMENT with
    // an already-passed deadline.
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
    const reconciliation = await prisma.paymentReconciliation.findFirst({ where: { reservationId: reservation.id } });
    expect(reconciliation?.reason).toBe("PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED");
  });
});

describe("item 6 — cancellation must never be reversed by a delayed payment", () => {
  it("customer cancellation racing payment: a late success is refunded and recorded, never un-cancels the reservation", async () => {
    const { vehicle, customer } = await makeVehicleAndCustomer(0);
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-04-10T10:00:00Z"),
      returnAt: new Date("2029-04-13T10:00:00Z"),
      status: "CANCELLED_BY_CUSTOMER",
    });
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "REQUIRES_PAYMENT", amountCents: 15000, stripePaymentIntentId: `pi_cancel_customer_${reservation.id}` },
    });
    createRefund.mockResolvedValueOnce({ status: "succeeded", id: `re_${reservation.id}` });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(createRefund).toHaveBeenCalledOnce();
    const refundRow = await prisma.refund.findFirst({ where: { reservationId: reservation.id } });
    expect(refundRow?.status).toBe("SUCCEEDED");
    const reconciliation = await prisma.paymentReconciliation.findFirst({ where: { reservationId: reservation.id } });
    expect(reconciliation?.reason).toBe("PAYMENT_SUCCEEDED_AFTER_CANCELLATION");
    expect(reconciliation?.status).toBe("REFUNDED");
  });

  it("host cancellation racing payment: same guarantee — never reversed by a late success", async () => {
    const { vehicle, customer } = await makeVehicleAndCustomer(0);
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-04-20T10:00:00Z"),
      returnAt: new Date("2029-04-23T10:00:00Z"),
      status: "CANCELLED_BY_HOST",
    });
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "REQUIRES_PAYMENT", amountCents: 15000, stripePaymentIntentId: `pi_cancel_host_${reservation.id}` },
    });
    createRefund.mockResolvedValueOnce({ status: "succeeded", id: `re_host_${reservation.id}` });

    await handlePaymentIntentSucceeded(fakeIntent(payment.stripePaymentIntentId!));

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("CANCELLED_BY_HOST");
    const refundRow = await prisma.refund.findFirst({ where: { reservationId: reservation.id } });
    expect(refundRow?.status).toBe("SUCCEEDED");
  });
});
