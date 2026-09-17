import { afterAll, describe, expect, it } from "vitest";
import { verifyDocumentOwnership } from "@/lib/documents";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation } from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  await prisma.driverDocument.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.reservation.deleteMany({ where: { vehicleId: { in: cleanupVehicleIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe("verifyDocumentOwnership — unauthorized document association", () => {
  it("allows attaching a document the user owns and that isn't attached to any reservation yet", async () => {
    const owner = await createTestCustomer();
    cleanupUserIds.push(owner.id);
    const vehicle = await createTestVehicle();
    cleanupVehicleIds.push(vehicle.id);
    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: owner.id,
      pickupAt: new Date("2029-03-01T10:00:00Z"),
      returnAt: new Date("2029-03-04T10:00:00Z"),
    });
    const doc = await prisma.driverDocument.create({
      data: { userId: owner.id, type: "LICENSE_FRONT", storageKey: "local:x", mimeType: "image/jpeg", fileSizeBytes: 10, contentSha256: "x" },
    });

    const ok = await verifyDocumentOwnership({ documentIds: [doc.id], userId: owner.id, reservationId: reservation.id });
    expect(ok).toBe(true);
  });

  it("REJECTS attaching a document uploaded by a different user", async () => {
    const owner = await createTestCustomer();
    const attacker = await createTestCustomer();
    cleanupUserIds.push(owner.id, attacker.id);
    const vehicle = await createTestVehicle();
    cleanupVehicleIds.push(vehicle.id);
    const attackerReservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: attacker.id,
      pickupAt: new Date("2029-03-10T10:00:00Z"),
      returnAt: new Date("2029-03-13T10:00:00Z"),
    });
    // Document uploaded by `owner`, not `attacker`.
    const doc = await prisma.driverDocument.create({
      data: { userId: owner.id, type: "LICENSE_FRONT", storageKey: "local:y", mimeType: "image/jpeg", fileSizeBytes: 10, contentSha256: "y" },
    });

    // `attacker` tries to attach `owner`'s document to their own reservation.
    const ok = await verifyDocumentOwnership({
      documentIds: [doc.id],
      userId: attacker.id,
      reservationId: attackerReservation.id,
    });
    expect(ok).toBe(false);
  });

  it("REJECTS re-attaching a document that is already attached to a DIFFERENT reservation of the same user", async () => {
    const owner = await createTestCustomer();
    cleanupUserIds.push(owner.id);
    const vehicle = await createTestVehicle();
    cleanupVehicleIds.push(vehicle.id);
    const reservationA = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: owner.id,
      pickupAt: new Date("2029-04-01T10:00:00Z"),
      returnAt: new Date("2029-04-04T10:00:00Z"),
    });
    const reservationB = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: owner.id,
      pickupAt: new Date("2029-05-01T10:00:00Z"),
      returnAt: new Date("2029-05-04T10:00:00Z"),
    });
    const doc = await prisma.driverDocument.create({
      data: {
        userId: owner.id,
        reservationId: reservationA.id,
        type: "LICENSE_FRONT",
        storageKey: "local:z",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        contentSha256: "z",
      },
    });

    const ok = await verifyDocumentOwnership({ documentIds: [doc.id], userId: owner.id, reservationId: reservationB.id });
    expect(ok).toBe(false);
  });
});
