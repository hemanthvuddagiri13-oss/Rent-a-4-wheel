import { afterAll, describe, expect, it } from "vitest";
import {
  assertTransitionAllowed,
  IllegalTransitionError,
  isTransitionAllowed,
  transitionReservation,
  StaleReservationStateError,
} from "@/lib/reservation-state-machine";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation } from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  await prisma.reservation.deleteMany({ where: { vehicleId: { in: cleanupVehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe("reservation state machine — transition table", () => {
  it("allows the ordinary happy-path sequence", () => {
    expect(isTransitionAllowed("CHECKOUT_HOLD", "AWAITING_PAYMENT")).toBe(true);
    expect(isTransitionAllowed("AWAITING_PAYMENT", "CONFIRMED")).toBe(true);
    expect(isTransitionAllowed("CONFIRMED", "DOCUMENTS_REQUIRED")).toBe(true);
    expect(isTransitionAllowed("DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN")).toBe(true);
    expect(isTransitionAllowed("READY_TO_START", "ACTIVE")).toBe(true);
    expect(isTransitionAllowed("ACTIVE", "RETURN_IN_PROGRESS")).toBe(true);
    expect(isTransitionAllowed("RETURN_IN_PROGRESS", "COMPLETED")).toBe(true);
  });

  it("rejects skipping states (e.g. CHECKOUT_HOLD straight to CONFIRMED)", () => {
    expect(isTransitionAllowed("CHECKOUT_HOLD", "CONFIRMED")).toBe(false);
  });

  it("rejects moving backwards out of a terminal state", () => {
    expect(isTransitionAllowed("COMPLETED", "ACTIVE")).toBe(false);
    expect(isTransitionAllowed("CANCELLED_BY_CUSTOMER", "CONFIRMED")).toBe(false);
    expect(isTransitionAllowed("EXPIRED", "CHECKOUT_HOLD")).toBe(false);
  });

  it("rejects re-confirming an already-confirmed reservation", () => {
    expect(isTransitionAllowed("CONFIRMED", "CONFIRMED")).toBe(false);
  });

  it("assertTransitionAllowed throws IllegalTransitionError for an illegal move", () => {
    expect(() => assertTransitionAllowed("ACTIVE", "CONFIRMED")).toThrow(IllegalTransitionError);
  });

  it("assertTransitionAllowed does not throw for a legal move", () => {
    expect(() => assertTransitionAllowed("AWAITING_PAYMENT", "PAYMENT_FAILED")).not.toThrow();
  });
});

describe("transitionReservation — enforced against the database", () => {
  it("rejects and leaves the row unchanged when the transition is illegal", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-01-10T10:00:00Z"),
      returnAt: new Date("2028-01-13T10:00:00Z"),
      status: "CONFIRMED",
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await transitionReservation(tx, { id: reservation.id, from: "CONFIRMED", to: "ACTIVE" });
      })
    ).rejects.toThrow(IllegalTransitionError);

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("CONFIRMED");
  });

  it("rejects with StaleReservationStateError when the row already moved on (compare-and-swap)", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-02-10T10:00:00Z"),
      returnAt: new Date("2028-02-13T10:00:00Z"),
      status: "AWAITING_PAYMENT",
    });

    // Simulate a concurrent process having already confirmed it.
    await prisma.reservation.update({ where: { id: reservation.id }, data: { status: "CONFIRMED" } });

    await expect(
      prisma.$transaction(async (tx) => {
        await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "PAYMENT_FAILED" });
      })
    ).rejects.toThrow(StaleReservationStateError);
  });

  it("applies a legal transition and persists it", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-03-10T10:00:00Z"),
      returnAt: new Date("2028-03-13T10:00:00Z"),
      status: "AWAITING_PAYMENT",
    });

    await prisma.$transaction(async (tx) => {
      await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "CONFIRMED" });
    });

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("CONFIRMED");
  });
});
