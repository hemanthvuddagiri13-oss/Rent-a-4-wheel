import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { isVehicleAvailable, getAvailableVehicleIds } from "@/lib/availability";

const prisma = new PrismaClient();

let vehicleId: string;
let otherVehicleId: string;

beforeAll(async () => {
  const vehicle = await prisma.vehicle.create({
    data: {
      slug: `test-availability-vehicle-${Date.now()}`,
      vin: `TESTVIN${Date.now()}`,
      licensePlate: "TEST-001",
      year: 2024,
      make: "TestMake",
      model: "TestModel",
      category: "SEDAN",
      dailyRateCents: 5000,
      weeklyRateCents: 30000,
      monthlyRateCents: 90000,
      status: "ACTIVE",
    },
  });
  vehicleId = vehicle.id;

  const otherVehicle = await prisma.vehicle.create({
    data: {
      slug: `test-availability-vehicle-b-${Date.now()}`,
      vin: `TESTVINB${Date.now()}`,
      licensePlate: "TEST-002",
      year: 2024,
      make: "TestMake",
      model: "OtherModel",
      category: "SEDAN",
      dailyRateCents: 5000,
      weeklyRateCents: 30000,
      monthlyRateCents: 90000,
      status: "ACTIVE",
    },
  });
  otherVehicleId = otherVehicle.id;

  const customer = await prisma.user.create({
    data: { email: `test-availability-${Date.now()}@example.com`, role: "CUSTOMER" },
  });

  // Existing confirmed reservation: Jan 10 - Jan 15
  await prisma.reservation.create({
    data: {
      confirmationNumber: `RA4W-TST${Date.now() % 1000000}`,
      customerId: customer.id,
      vehicleId,
      pickupAt: new Date("2027-01-10T10:00:00Z"),
      returnAt: new Date("2027-01-15T10:00:00Z"),
      rateType: "DAILY",
      rateAmountCents: 5000,
      units: 5,
      subtotalCents: 25000,
      totalCents: 25000,
      status: "CONFIRMED",
      driverFirstName: "Test",
      driverLastName: "User",
      driverDob: new Date("1990-01-01"),
      driverEmail: "test@example.com",
      driverPhone: "555-0100",
      driverAddress: "123 St",
      driverCity: "Dallas",
      driverState: "TX",
      driverZip: "75201",
      licenseNumber: "TX123",
      licenseState: "TX",
      licenseExpiration: new Date("2030-01-01"),
    },
  });
});

afterAll(async () => {
  await prisma.reservation.deleteMany({ where: { vehicleId: { in: [vehicleId, otherVehicleId] } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: [vehicleId, otherVehicleId] } } });
  await prisma.user.deleteMany({ where: { email: { contains: "test-availability-" } } });
  await prisma.$disconnect();
});

describe("isVehicleAvailable — overlap detection", () => {
  it("is unavailable for a range fully inside an existing reservation", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-01-11"), new Date("2027-01-12"));
    expect(available).toBe(false);
  });

  it("is unavailable when the requested range partially overlaps the start", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-01-08"), new Date("2027-01-11"));
    expect(available).toBe(false);
  });

  it("is unavailable when the requested range partially overlaps the end", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-01-14"), new Date("2027-01-17"));
    expect(available).toBe(false);
  });

  it("is unavailable when the requested range fully contains an existing reservation", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-01-05"), new Date("2027-01-20"));
    expect(available).toBe(false);
  });

  it("is available for a range that ends exactly when the existing one starts (back-to-back)", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-01-05T10:00:00Z"), new Date("2027-01-10T10:00:00Z"));
    expect(available).toBe(true);
  });

  it("is available for a range that starts exactly when the existing one ends (back-to-back)", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-01-15T10:00:00Z"), new Date("2027-01-20T10:00:00Z"));
    expect(available).toBe(true);
  });

  it("is available for a completely disjoint date range", async () => {
    const available = await isVehicleAvailable(vehicleId, new Date("2027-02-01"), new Date("2027-02-05"));
    expect(available).toBe(true);
  });

  it("does not consider a different vehicle's reservation", async () => {
    const available = await isVehicleAvailable(otherVehicleId, new Date("2027-01-11"), new Date("2027-01-12"));
    expect(available).toBe(true);
  });
});

describe("getAvailableVehicleIds", () => {
  it("excludes a booked vehicle and includes an unbooked one for an overlapping window", async () => {
    const ids = await getAvailableVehicleIds(new Date("2027-01-11"), new Date("2027-01-12"));
    expect(ids).not.toContain(vehicleId);
    expect(ids).toContain(otherVehicleId);
  });

  it("includes both vehicles for a disjoint window", async () => {
    const ids = await getAvailableVehicleIds(new Date("2027-03-01"), new Date("2027-03-05"));
    expect(ids).toContain(vehicleId);
    expect(ids).toContain(otherVehicleId);
  });
});

describe("double-booking prevention under concurrency", () => {
  it("allows only one of two simultaneous booking transactions for the same slot to succeed", async () => {
    const pickupAt = new Date("2027-06-01T10:00:00Z");
    const returnAt = new Date("2027-06-04T10:00:00Z");

    async function attemptBook() {
      return prisma.$transaction(
        async (tx) => {
          const available = await isVehicleAvailable(otherVehicleId, pickupAt, returnAt, { tx });
          if (!available) throw new Error("UNAVAILABLE");
          // Simulate the read-then-write gap that makes double-booking possible
          // without serializable isolation.
          await new Promise((resolve) => setTimeout(resolve, 50));
          const customer = await tx.user.create({
            data: { email: `test-availability-concurrent-${Math.random()}@example.com`, role: "CUSTOMER" },
          });
          return tx.reservation.create({
            data: {
              confirmationNumber: `RA4W-CC${Math.floor(Math.random() * 1000000)}`,
              customerId: customer.id,
              vehicleId: otherVehicleId,
              pickupAt,
              returnAt,
              rateType: "DAILY",
              rateAmountCents: 5000,
              units: 3,
              subtotalCents: 15000,
              totalCents: 15000,
              status: "CONFIRMED",
              driverFirstName: "Test",
              driverLastName: "User",
              driverDob: new Date("1990-01-01"),
              driverEmail: "test@example.com",
              driverPhone: "555-0100",
              driverAddress: "123 St",
              driverCity: "Dallas",
              driverState: "TX",
              driverZip: "75201",
              licenseNumber: "TX123",
              licenseState: "TX",
              licenseExpiration: new Date("2030-01-01"),
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    }

    const results = await Promise.allSettled([attemptBook(), attemptBook()]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const overlapping = await prisma.reservation.findMany({
      where: { vehicleId: otherVehicleId, pickupAt: { lt: returnAt }, returnAt: { gt: pickupAt } },
    });
    expect(overlapping).toHaveLength(1);
  });
});
