import { afterAll, describe, expect, it } from "vitest";
import { isVehicleAvailable } from "@/lib/availability";
import { expireStaleReservations } from "@/lib/cleanup";
import {
  prisma,
  createTestVehicle,
  createTestCustomer,
  createTestReservation,
  cleanupReservationsForVehicles,
} from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe("checkout holds — expiration and inventory blocking", () => {
  it("a live (non-expired) CHECKOUT_HOLD blocks the same dates for another customer", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-04-10T10:00:00Z"),
      returnAt: new Date("2028-04-13T10:00:00Z"),
      status: "CHECKOUT_HOLD",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const available = await isVehicleAvailable(vehicle.id, new Date("2028-04-11T00:00:00Z"), new Date("2028-04-12T00:00:00Z"));
    expect(available).toBe(false);
  });

  it("an expired CHECKOUT_HOLD does not block inventory, even before cleanup runs", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-05-10T10:00:00Z"),
      returnAt: new Date("2028-05-13T10:00:00Z"),
      status: "CHECKOUT_HOLD",
      expiresAt: new Date(Date.now() - 60 * 1000), // expired one minute ago
    });

    const available = await isVehicleAvailable(vehicle.id, new Date("2028-05-11T00:00:00Z"), new Date("2028-05-12T00:00:00Z"));
    expect(available).toBe(true);
  });

  it("an expired AWAITING_PAYMENT reservation does not block inventory indefinitely", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-06-10T10:00:00Z"),
      returnAt: new Date("2028-06-13T10:00:00Z"),
      status: "AWAITING_PAYMENT",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    const available = await isVehicleAvailable(vehicle.id, new Date("2028-06-11T00:00:00Z"), new Date("2028-06-12T00:00:00Z"));
    expect(available).toBe(true);
  });

  it("expireStaleReservations sweeps expired holds/awaiting-payment rows to EXPIRED and leaves live ones alone", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    const expiredHold = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-07-10T10:00:00Z"),
      returnAt: new Date("2028-07-13T10:00:00Z"),
      status: "CHECKOUT_HOLD",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const liveHold = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2028-08-10T10:00:00Z"),
      returnAt: new Date("2028-08-13T10:00:00Z"),
      status: "CHECKOUT_HOLD",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    await expireStaleReservations();

    const [reloadedExpired, reloadedLive] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: expiredHold.id } }),
      prisma.reservation.findUniqueOrThrow({ where: { id: liveHold.id } }),
    ]);

    expect(reloadedExpired.status).toBe("EXPIRED");
    expect(reloadedLive.status).toBe("CHECKOUT_HOLD");
  });
});

describe("simultaneous overlapping checkout-hold attempts", () => {
  it("only one of two concurrent SERIALIZABLE hold-creation attempts for the same slot succeeds", async () => {
    const vehicle = await createTestVehicle();
    cleanupVehicleIds.push(vehicle.id);

    const pickupAt = new Date("2028-09-01T10:00:00Z");
    const returnAt = new Date("2028-09-04T10:00:00Z");

    async function attemptHold() {
      const customer = await createTestCustomer();
      cleanupUserIds.push(customer.id);
      return prisma.$transaction(
        async (tx) => {
          const available = await isVehicleAvailable(vehicle.id, pickupAt, returnAt, { tx });
          if (!available) throw new Error("UNAVAILABLE");
          await new Promise((resolve) => setTimeout(resolve, 50));
          // Write via the same `tx` the availability check ran in — writing
          // through the standalone `prisma` client here would escape the
          // transaction and defeat the point of this test.
          return tx.reservation.create({
            data: {
              confirmationNumber: `RA4W-CH${Math.floor(Math.random() * 1_000_000)}`,
              customerId: customer.id,
              vehicleId: vehicle.id,
              pickupAt,
              returnAt,
              rateType: "DAILY",
              rateAmountCents: 5000,
              units: 3,
              subtotalCents: 15000,
              totalCents: 15000,
              status: "CHECKOUT_HOLD",
              expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            },
          });
        },
        { isolationLevel: "Serializable" }
      );
    }

    const results = await Promise.allSettled([attemptHold(), attemptHold()]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });
});
