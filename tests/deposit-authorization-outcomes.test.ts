import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const createPaymentIntent = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent } },
}));

const { attemptDepositAuthorization } = await import("@/lib/deposit-authorization");
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

async function setupReservationWithDeposit() {
  const vehicle = await createTestVehicle();
  const customer = await createTestCustomer();
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id);
  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date("2029-10-10T10:00:00Z"),
    returnAt: new Date("2029-10-13T10:00:00Z"),
    status: "AWAITING_PAYMENT",
    depositCents: 30000,
  });
  const deposit = await prisma.securityDeposit.create({
    data: { reservationId: reservation.id, amountCents: 30000, status: "REQUIRES_PAYMENT" },
  });
  return { reservation, deposit };
}

function fakeIntent() {
  return { payment_method: "pm_test_123", customer: "cus_test_123" } as never;
}

describe("item 5/6 — deposit authorization requiring authentication (3DS) is not a valid authorization", () => {
  it("treats a resolved call with status requires_action as FAILED, not SUCCEEDED", async () => {
    const { reservation, deposit } = await setupReservationWithDeposit();
    createPaymentIntent.mockResolvedValueOnce({ id: "pi_3ds", status: "requires_action" });

    const outcome = await attemptDepositAuthorization({ id: reservation.id, deposit }, fakeIntent());

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.failureReason).toContain("requires_action");
    }
  });

  it("treats status requires_capture as a genuine success", async () => {
    const { reservation, deposit } = await setupReservationWithDeposit();
    createPaymentIntent.mockResolvedValueOnce({ id: "pi_ok", status: "requires_capture", created: Math.floor(Date.now()/1000), latest_charge: { id: "ch_test", created: Math.floor(Date.now()/1000), payment_method_details: { card: { capture_before: Math.floor(Date.now()/1000) + 3600 } } } });

    const outcome = await attemptDepositAuthorization({ id: reservation.id, deposit }, fakeIntent());
    expect(outcome.outcome).toBe("succeeded");
  });
});
