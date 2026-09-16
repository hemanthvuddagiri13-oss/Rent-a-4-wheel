import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const createRefund = vi.fn();
let mockSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/lib/stripe", () => ({
  stripe: { refunds: { create: createRefund } },
}));
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(mockSession) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/notifications", () => ({ queueNotification: () => Promise.resolve() }));

const { issueRefund } = await import("@/app/admin/reservations/actions");
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
  const admin = await createTestCustomer({ role: "ADMIN" });
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id, admin.id);
  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date("2029-11-10T10:00:00Z"),
    returnAt: new Date("2029-11-13T10:00:00Z"),
    status: "CONFIRMED",
  });
  await prisma.payment.create({
    data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: `pi_admin_${reservation.id}` },
  });
  mockSession = { user: { id: admin.id, role: "ADMIN" } };
  return { reservation };
}

describe("item 15 — idempotent staff-initiated refunds", () => {
  it("rejects a non-positive refund amount", async () => {
    const { reservation } = await setupPaidReservation();
    await expect(issueRefund(reservation.id, 0, crypto.randomUUID())).rejects.toThrow(/positive/);
  });

  it("rejects a refund amount exceeding the remaining refundable balance", async () => {
    const { reservation } = await setupPaidReservation();
    await expect(issueRefund(reservation.id, 20000, crypto.randomUUID())).rejects.toThrow(/exceeds/);
  });

  it("a retried submission with the same requestId never calls Stripe twice", async () => {
    const { reservation } = await setupPaidReservation();
    createRefund.mockResolvedValue({ id: "re_admin_1", status: "succeeded" });
    const requestId = crypto.randomUUID();

    await issueRefund(reservation.id, 15000, requestId, "Customer request");
    // Simulates a double-click / network retry re-submitting the exact
    // same form state before the UI disabled the button.
    await issueRefund(reservation.id, 15000, requestId, "Customer request");

    expect(createRefund).toHaveBeenCalledTimes(1);
    const refunds = await prisma.refund.findMany({ where: { reservationId: reservation.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.status).toBe("SUCCEEDED");
  });

  it("a genuinely new refund (different requestId) after a completed one is a separate operation", async () => {
    const { reservation } = await setupPaidReservation();
    createRefund.mockResolvedValueOnce({ id: "re_admin_first", status: "succeeded" });
    await issueRefund(reservation.id, 5000, crypto.randomUUID(), "First partial refund");

    createRefund.mockResolvedValueOnce({ id: "re_admin_second", status: "succeeded" });
    await issueRefund(reservation.id, 5000, crypto.randomUUID(), "Second partial refund");

    const refunds = await prisma.refund.findMany({ where: { reservationId: reservation.id } });
    expect(refunds).toHaveLength(2);
    expect(createRefund).toHaveBeenCalledTimes(2);
  });
});
