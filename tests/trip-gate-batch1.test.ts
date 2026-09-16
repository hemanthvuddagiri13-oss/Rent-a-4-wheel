import { afterAll, describe, expect, it } from "vitest";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function setupConfirmedReservation() {
  const vehicle = await createTestVehicle();
  const customer = await createTestCustomer();
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id);
  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date(Date.now() - 60 * 60 * 1000),
    returnAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    status: "READY_TO_START",
    depositCents: 30000,
  });
  return { vehicle, customer, reservation };
}

describe("item 9 — trip start requires a positive net paid balance", () => {
  it("a fully refunded reservation must not be allowed to start a trip", async () => {
    const { reservation } = await setupConfirmedReservation();
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: `pi_gate_${reservation.id}` },
    });
    await prisma.refund.create({
      data: { reservationId: reservation.id, paymentId: payment.id, amountCents: 15000, status: "SUCCEEDED", idempotencyKey: `gate-refund-${reservation.id}` },
    });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("fully refunded"))).toBe(true);
  });

  it("a partially refunded reservation with remaining positive balance is not blocked by the balance check", async () => {
    const { reservation } = await setupConfirmedReservation();
    const payment = await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: `pi_gate_partial_${reservation.id}` },
    });
    await prisma.refund.create({
      data: { reservationId: reservation.id, paymentId: payment.id, amountCents: 5000, status: "SUCCEEDED", idempotencyKey: `gate-refund-partial-${reservation.id}` },
    });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.reasons.some((r) => r.includes("fully refunded"))).toBe(false);
  });
});

describe("item 5 — trip start requires a currently valid deposit authorization", () => {
  it("blocks trip start when the deposit authorization has expired", async () => {
    const { reservation } = await setupConfirmedReservation();
    await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: `pi_deposit_gate_${reservation.id}` },
    });
    await prisma.securityDeposit.create({
      data: {
        reservationId: reservation.id,
        amountCents: 30000,
        status: "SUCCEEDED",
        stripeStatus: "requires_capture",
        authorizedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        authorizationExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // already expired
      },
    });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.reasons.some((r) => r.includes("currently valid authorization"))).toBe(true);
  });

  it("does not add a deposit reason when the authorization is still valid", async () => {
    const { reservation } = await setupConfirmedReservation();
    await prisma.payment.create({
      data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: `pi_deposit_gate_valid_${reservation.id}` },
    });
    await prisma.securityDeposit.create({
      data: {
        reservationId: reservation.id,
        amountCents: 30000,
        status: "SUCCEEDED",
        stripeStatus: "requires_capture",
        authorizedAt: new Date(),
        authorizationExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      },
    });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.reasons.some((r) => r.includes("authorization"))).toBe(false);
  });
});
