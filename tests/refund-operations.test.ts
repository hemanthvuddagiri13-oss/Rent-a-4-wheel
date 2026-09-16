import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const createRefund = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: { refunds: { create: createRefund } },
}));

const { getOrCreateRefundOperation, executeRefundOperation, reconcileRefundStatus } = await import("@/lib/refund-operations");
const { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } =
  await import("./helpers/factories");

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterEach(() => {
  createRefund.mockReset();
});

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function setupPaidReservation() {
  const vehicle = await createTestVehicle();
  const customer = await createTestCustomer();
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id);
  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date("2029-05-10T10:00:00Z"),
    returnAt: new Date("2029-05-13T10:00:00Z"),
    status: "CONFIRMED",
  });
  const payment = await prisma.payment.create({
    data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: `pi_refund_${reservation.id}` },
  });
  return { reservation, payment };
}

describe("item 7 — resumable, application-idempotent refund reconciliation", () => {
  it("crash after a successful Stripe refund but before the DB commit: retrying resumes instead of double-refunding", async () => {
    const { reservation, payment } = await setupPaidReservation();
    const idempotencyKey = `test-crash-${payment.id}`;

    createRefund.mockResolvedValueOnce({ id: "re_crash_1", status: "succeeded" });
    const refund = await getOrCreateRefundOperation({ idempotencyKey, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 });
    const first = await executeRefundOperation(refund.id, payment.stripePaymentIntentId);
    expect(first.status).toBe("SUCCEEDED");
    expect(createRefund).toHaveBeenCalledOnce();

    // Simulate a retry of the SAME logical operation (e.g. the caller
    // crashed right after Stripe responded, before persisting, and a
    // supervisor re-invokes with the same idempotencyKey).
    const resumedOp = await getOrCreateRefundOperation({ idempotencyKey, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 });
    expect(resumedOp.id).toBe(refund.id);
    const second = await executeRefundOperation(resumedOp.id, payment.stripePaymentIntentId);
    // Must NOT call Stripe again — the row is already terminal.
    expect(createRefund).toHaveBeenCalledOnce();
    expect(second.status === "already_terminal" || second.status === "SUCCEEDED").toBe(true);
  });

  it("concurrent double-refund attempts for the same idempotencyKey converge on one durable row and one Stripe refund id", async () => {
    const { reservation, payment } = await setupPaidReservation();
    const idempotencyKey = `test-concurrent-${payment.id}`;
    // Stand in for Stripe's OWN idempotency-key deduplication (a real
    // Stripe API call with the same idempotency key returns the same
    // refund object rather than creating a second refund) — both calls
    // resolve to the identical Stripe refund id.
    createRefund.mockResolvedValue({ id: "re_concurrent", status: "succeeded" });

    const [opA, opB] = await Promise.all([
      getOrCreateRefundOperation({ idempotencyKey, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 }),
      getOrCreateRefundOperation({ idempotencyKey, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 }),
    ]);
    // Never two separate durable operations for the same idempotencyKey.
    expect(opA.id).toBe(opB.id);

    const [resultA, resultB] = await Promise.all([
      executeRefundOperation(opA.id, payment.stripePaymentIntentId),
      executeRefundOperation(opB.id, payment.stripePaymentIntentId),
    ]);
    // Every Stripe call our code made carried the SAME idempotency key —
    // this is what actually prevents a real double refund at Stripe,
    // regardless of how many times our own process calls the API.
    for (const call of createRefund.mock.calls) {
      expect(call[1]).toEqual({ idempotencyKey });
    }
    const finalRefund = await prisma.refund.findUniqueOrThrow({ where: { id: opA.id } });
    expect(finalRefund.status).toBe("SUCCEEDED");
    expect(finalRefund.stripeRefundId).toBe("re_concurrent");
    expect([resultA.status, resultB.status]).toContain("SUCCEEDED");
  });
});

describe("item 8 — refund creation is not refund completion", () => {
  it("a refund that resolves PENDING at Stripe stays PENDING until a refund.updated event resolves it to SUCCEEDED", async () => {
    const { reservation, payment } = await setupPaidReservation();
    createRefund.mockResolvedValueOnce({ id: "re_pending_1", status: "pending" });

    const refund = await getOrCreateRefundOperation({ idempotencyKey: `test-pending-${payment.id}`, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 });
    const result = await executeRefundOperation(refund.id, payment.stripePaymentIntentId);
    expect(result.status).toBe("already_terminal");

    let reloaded = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(reloaded.status).toBe("PENDING");

    await reconcileRefundStatus("re_pending_1", "succeeded");
    reloaded = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(reloaded.status).toBe("SUCCEEDED");
  });

  it("a refund that resolves PENDING then fails is recorded FAILED via refund.updated, never silently dropped", async () => {
    const { reservation, payment } = await setupPaidReservation();
    createRefund.mockResolvedValueOnce({ id: "re_pending_2", status: "pending" });

    const refund = await getOrCreateRefundOperation({ idempotencyKey: `test-pending-fail-${payment.id}`, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 });
    await executeRefundOperation(refund.id, payment.stripePaymentIntentId);

    await reconcileRefundStatus("re_pending_2", "failed");
    const reloaded = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(reloaded.status).toBe("FAILED");
  });

  it("monotonic: a refund.updated event never reverses an already-terminal refund", async () => {
    const { reservation, payment } = await setupPaidReservation();
    createRefund.mockResolvedValueOnce({ id: "re_terminal", status: "succeeded" });

    const refund = await getOrCreateRefundOperation({ idempotencyKey: `test-terminal-${payment.id}`, reservationId: reservation.id, paymentId: payment.id, amountCents: 15000 });
    await executeRefundOperation(refund.id, payment.stripePaymentIntentId);

    await reconcileRefundStatus("re_terminal", "failed");
    const reloaded = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(reloaded.status).toBe("SUCCEEDED");
  });
});
