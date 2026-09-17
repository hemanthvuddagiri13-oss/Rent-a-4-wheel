import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma, createTestHost, createTestCustomer, createTestVehicle, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";
import { hostCommand, saveListing, saveHostProfile, marketplaceHost } from "@/lib/marketplace";
import { tripCommand, tripExperience } from "@/lib/trip-experience";
import { isVehicleAvailable } from "@/lib/availability";
import { createOrRefreshHold } from "@/lib/checkout-hold";

const users: string[] = [], hosts: string[] = [], vehicles: string[] = [];
async function setup() {
  const h = await createTestHost(), customer = await createTestCustomer(), other = await createTestHost();
  users.push(h.user.id, customer.id, other.user.id); hosts.push(h.hostProfile.id, other.hostProfile.id);
  const vehicle = await createTestVehicle({ hostId: h.hostProfile.id }); vehicles.push(vehicle.id);
  return { ...h, customer, other, vehicle };
}
afterAll(async () => {
  await cleanupReservationsForVehicles(vehicles);
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.marketplaceRateLimit.deleteMany({ where: { key: { in: users.map(id => `marketplace:${id}`) } } });
  await prisma.marketplaceFile.deleteMany({ where: { hostId: { in: hosts } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } });
  await prisma.vehicleOwner.deleteMany({ where: { hostId: { in: hosts } } });
  await prisma.hostProfile.deleteMany({ where: { id: { in: hosts } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

describe("marketplace permissions and real PostgreSQL state", () => {
  it("submits a customer host application without approving it or elevating staff", async () => {
    const u = await createTestCustomer(); users.push(u.id);
    const body = { legalName: "Synthetic LLC", businessName: "Synthetic fleet", phone: "5551234567", addressLine1: "1 Test Street", city: "Dallas", state: "TX", zip: "75001" };
    const result = await saveHostProfile(u.id, body); hosts.push(result.id);
    expect(await prisma.hostProfile.findUnique({ where: { id: result.id } })).toMatchObject({ onboardingStatus: "SUBMITTED", approvedAt: null });
    await prisma.user.update({ where: { id: u.id }, data: { role: "STAFF" } });
    await expect(saveHostProfile(u.id, body)).rejects.toThrow("Only an account owner");
  });
  it("rejects unrelated hosts and staff fleet mutations, and revokes employee access immediately", async () => {
    const f = await setup(), staff = await createTestCustomer(); users.push(staff.id);
    await hostCommand(f.user.id, { action: "employee", email: staff.email, role: "STAFF" });
    await expect(hostCommand(f.other.user.id, { action: "availability", vehicleId: f.vehicle.id, isBookable: false })).rejects.toThrow("Vehicle unavailable");
    await expect(hostCommand(staff.id, { action: "availability", vehicleId: f.vehicle.id, isBookable: false })).rejects.toThrow("Only the host owner or manager");
    const employee = await prisma.hostEmployee.findFirstOrThrow({ where: { userId: staff.id } });
    await hostCommand(f.user.id, { action: "removeEmployee", id: employee.id });
    await expect(marketplaceHost(prisma, staff.id)).rejects.toThrow("Host access required");
  });
  it("requires listing and host approval for availability", async () => {
    const f = await setup(), start = new Date("2034-01-01"), end = new Date("2034-01-03");
    expect(await isVehicleAvailable(f.vehicle.id, start, end)).toBe(true);
    await prisma.vehicle.update({ where: { id: f.vehicle.id }, data: { listingApproval: "PENDING" } });
    expect(await isVehicleAvailable(f.vehicle.id, start, end)).toBe(false);
    await prisma.vehicle.update({ where: { id: f.vehicle.id }, data: { listingApproval: "APPROVED" } });
    await prisma.hostProfile.update({ where: { id: f.hostProfile.id }, data: { onboardingStatus: "SUSPENDED" } });
    expect(await isVehicleAvailable(f.vehicle.id, start, end)).toBe(false);
  });
  it("rejects another host's owner assignment and saves valid listings as unavailable pending review", async () => {
    const f = await setup();
    await hostCommand(f.other.user.id, { action: "owner", name: "Foreign owner", email: "owner@example.test", phone: "5550001111" });
    const owner = await prisma.vehicleOwner.findFirstOrThrow({ where: { hostId: f.other.hostProfile.id } });
    const body = { vin: "1HGCM82633A" + String(Date.now()).slice(-6), licensePlate: "TEST", year: 2024, make: "Honda", model: "Accord", category: "SEDAN", transmission: "AUTOMATIC", fuelType: "GASOLINE", seats: 5, mileage: 1000, dailyRateCents: 5000, weeklyRateCents: 30000, monthlyRateCents: 100000, securityDepositCents: 0, mileageAllowancePerDay: 150, additionalMileageFeeCents: 35, description: "Synthetic vehicle listing for an integration test", rules: "", location: "Dallas, TX", registrationExpiresAt: "2035-01-01T00:00:00Z", insuranceExpiresAt: "2035-01-01T00:00:00Z", ownershipType: "COMPANY_OWNED", features: ["Bluetooth"] };
    await expect(saveListing(f.user.id, { ...body, ownerId: owner.id })).rejects.toThrow("Choose an owner");
    const saved = await saveListing(f.user.id, body); vehicles.push(saved.id);
    expect(await prisma.vehicle.findUnique({ where: { id: saved.id } })).toMatchObject({ listingApproval: "PENDING", status: "INACTIVE", hostId: f.hostProfile.id });
  });
  it("serializes a calendar block against checkout using separate PostgreSQL connections and a barrier", async () => {
    const f = await setup(), separate = new PrismaClient();
    let release!: () => void, arrived!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { arrived = resolve; });
    const holder = separate.$transaction(async tx => {
      await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + f.vehicle.id})`;
      arrived(); await barrier;
      await tx.vehicleBlock.create({ data: { vehicleId: f.vehicle.id, startAt: new Date("2034-02-01"), endAt: new Date("2034-02-04"), reason: "MAINTENANCE" } });
    }, { timeout: 15000 });
    await ready;
    let settled = false;
    const checkout = createOrRefreshHold({ vehicleId: f.vehicle.id, customerId: f.customer.id, extraIds: [], pickupAt: new Date("2034-02-01"), returnAt: new Date("2034-02-03") }).finally(() => { settled = true; });
    // Observe the blocked connection in PostgreSQL, not a sequential promise chain.
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const rows = await separate.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%financial_guard_xact%'`;
      if (Number(rows[0].n)) { waiting = true; break; } await new Promise(r => setTimeout(r, 10));
    }
    release(); await holder;
    await expect(checkout).rejects.toThrow("no longer available");
    expect(waiting).toBe(true); expect(settled).toBe(true);
    expect(await prisma.reservation.count({ where: { vehicleId: f.vehicle.id } })).toBe(0);
    await separate.$disconnect();
  });
  it("isolates trip data and only completes after both accepted return reports", async () => {
    const f = await setup(), r = await createTestReservation({ vehicleId: f.vehicle.id, customerId: f.customer.id, pickupAt: new Date(Date.now() - 3600000), returnAt: new Date(Date.now() + 3600000), status: "ACTIVE" });
    await prisma.trip.create({ data: { reservationId: r.id, startedAt: new Date(), startMileage: 1000, startFuelLevel: 100 } });
    await expect(tripExperience(f.other.user.id, r.id)).rejects.toThrow("Reservation unavailable");
    await tripCommand(f.customer.id, r.id, "return");
    await expect(tripCommand(f.customer.id, r.id, "complete")).rejects.toThrow("assigned host");
    await expect(tripCommand(f.user.id, r.id, "complete")).rejects.toThrow("Both parties");
    for (const [submittedById, submittedByRole] of [[f.customer.id, "CUSTOMER"], [f.user.id, "HOST"]] as const) await prisma.conditionReport.create({ data: { reservationId: r.id, phase: "POST_TRIP", submittedById, submittedByRole, mileage: 1100, fuelLevel: 90, acceptedAt: new Date(), photos: { create: [{ category: "EXTERIOR", storageKey: "local:synthetic" }, { category: "INTERIOR", storageKey: "local:synthetic" }] } } });
    const separate = new PrismaClient();
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { arrived = resolve; });
    const holder = separate.$transaction(async tx => { await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + f.vehicle.id})`; arrived(); await gate; }, { timeout: 15000 });
    await ready;
    const requests = [tripCommand(f.user.id, r.id, "complete"), tripCommand(f.user.id, r.id, "complete")];
    let bothWaiting = false;
    for (let i = 0; i < 100; i++) {
      const waits = await separate.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%financial_guard_xact%'`;
      if (Number(waits[0].n) >= 2) { bothWaiting = true; break; } await new Promise(resolve => setTimeout(resolve, 10));
    }
    release(); await holder; await Promise.all(requests); await separate.$disconnect();
    expect(bothWaiting).toBe(true);
    expect(await prisma.reservation.findUnique({ where: { id: r.id } })).toMatchObject({ status: "COMPLETED", financialDisposition: "TERMINATED" });
    expect(await prisma.tripEvent.count({ where: { reservationId: r.id, type: "RETURN_REVIEWED" } })).toBe(1);
  });
});
