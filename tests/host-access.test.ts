import { afterAll, describe, expect, it } from "vitest";
import { getHostContext, hostOwnsVehicle, hostOwnsReservation } from "@/lib/host-access";
import { prisma, createTestVehicle, createTestCustomer, createTestHost, createTestReservation } from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupHostIds: string[] = [];

afterAll(async () => {
  await prisma.reservation.deleteMany({ where: { vehicleId: { in: cleanupVehicleIds } } });
  await prisma.hostEmployee.deleteMany({ where: { hostId: { in: cleanupHostIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.hostProfile.deleteMany({ where: { id: { in: cleanupHostIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe("host cross-tenant access controls", () => {
  it("a host can access their own vehicle", async () => {
    const { user, hostProfile } = await createTestHost();
    const vehicle = await createTestVehicle({ hostId: hostProfile.id });
    cleanupUserIds.push(user.id);
    cleanupHostIds.push(hostProfile.id);
    cleanupVehicleIds.push(vehicle.id);

    const context = await getHostContext(user.id);
    expect(context).not.toBeNull();
    expect(await hostOwnsVehicle(context!, vehicle.id)).toBe(true);
  });

  it("a host CANNOT access a different host's vehicle", async () => {
    const hostA = await createTestHost();
    const hostB = await createTestHost();
    const vehicleForB = await createTestVehicle({ hostId: hostB.hostProfile.id });
    cleanupUserIds.push(hostA.user.id, hostB.user.id);
    cleanupHostIds.push(hostA.hostProfile.id, hostB.hostProfile.id);
    cleanupVehicleIds.push(vehicleForB.id);

    const contextA = await getHostContext(hostA.user.id);
    expect(await hostOwnsVehicle(contextA!, vehicleForB.id)).toBe(false);
  });

  it("a host employee inherits access to their host's vehicles/reservations only", async () => {
    const host = await createTestHost();
    const otherHost = await createTestHost();
    const employee = await createTestCustomer({ role: "HOST_EMPLOYEE" });
    await prisma.hostEmployee.create({ data: { hostId: host.hostProfile.id, userId: employee.id, role: "STAFF" } });

    const vehicle = await createTestVehicle({ hostId: host.hostProfile.id });
    const otherVehicle = await createTestVehicle({ hostId: otherHost.hostProfile.id });
    const customer = await createTestCustomer();
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date("2029-02-01T10:00:00Z"),
      returnAt: new Date("2029-02-04T10:00:00Z"),
      status: "CONFIRMED",
    });

    cleanupUserIds.push(host.user.id, otherHost.user.id, employee.id, customer.id);
    cleanupHostIds.push(host.hostProfile.id, otherHost.hostProfile.id);
    cleanupVehicleIds.push(vehicle.id, otherVehicle.id);

    const employeeContext = await getHostContext(employee.id);
    expect(employeeContext?.hostId).toBe(host.hostProfile.id);
    expect(await hostOwnsVehicle(employeeContext!, vehicle.id)).toBe(true);
    expect(await hostOwnsVehicle(employeeContext!, otherVehicle.id)).toBe(false);
    expect(await hostOwnsReservation(employeeContext!, reservation.id)).toBe(true);
  });

  it("a user with no host affiliation has no host context at all", async () => {
    const customer = await createTestCustomer();
    cleanupUserIds.push(customer.id);
    const context = await getHostContext(customer.id);
    expect(context).toBeNull();
  });
});
