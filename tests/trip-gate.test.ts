import { afterAll, describe, expect, it } from "vitest";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import {
  prisma,
  createTestVehicle,
  createTestCustomer,
  createTestHost,
  createTestReservation,
  cleanupReservationsForVehicles,
} from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupHostIds: string[] = [];

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.hostProfile.deleteMany({ where: { id: { in: cleanupHostIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function fullySetUpReservation(paid = true) {
  const vehicle = await createTestVehicle();
  const customer = await createTestCustomer();
  const { user: hostUser, hostProfile } = await createTestHost();
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id, hostUser.id);
  cleanupHostIds.push(hostProfile.id);

  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now — inside the 24h window
    returnAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
    status: "DOCUMENTS_REQUIRED",
  });

  await prisma.payment.create({
    data: { reservationId: reservation.id, type: "RENTAL", status: paid ? "SUCCEEDED" : "REQUIRES_PAYMENT", amountCents: 15000 },
  });

  await prisma.driverDocument.createMany({
    data: [
      { userId: customer.id, reservationId: reservation.id, type: "LICENSE_FRONT", storageKey: "local:a", mimeType: "image/jpeg", fileSizeBytes: 10, malwareScanStatus: "CLEAN", contentSha256: "a" },
      { userId: customer.id, reservationId: reservation.id, type: "LICENSE_BACK", storageKey: "local:b", mimeType: "image/jpeg", fileSizeBytes: 10, malwareScanStatus: "CLEAN", contentSha256: "b" },
      { userId: customer.id, reservationId: reservation.id, type: "SELFIE_WITH_LICENSE", storageKey: "local:c", mimeType: "image/jpeg", fileSizeBytes: 10, malwareScanStatus: "CLEAN", contentSha256: "c" },
    ],
  });

  await prisma.agreementAcceptance.create({
    data: {
      type: "RENTAL_AGREEMENT",
      documentVersion: "v1-draft",
      contentHash: "deadbeef",
      contentSnapshot: "test terms",
      reservationId: reservation.id,
      signedByUserId: customer.id,
      signerName: "Test Customer",
    },
  });

  await prisma.identityHandoffVerification.create({
    data: {
      reservationId: reservation.id,
      verifiedByHostId: hostUser.id,
      licenseMatchesUpload: true,
      physicalLicenseUnexpired: true,
      selfieMatchesCustomer: true,
      verifiedAt: new Date(),
    },
  });

  const hostReport = await prisma.conditionReport.create({
    data: {
      reservationId: reservation.id,
      phase: "PRE_TRIP",
      submittedByRole: "HOST",
      submittedById: hostUser.id,
      mileage: 1000,
      fuelLevel: 100,
      acceptedAt: new Date(),
      photos: { create: [{ category: "EXTERIOR", storageKey: "local:host-ext" }] },
    },
  });
  const customerReport = await prisma.conditionReport.create({
    data: {
      reservationId: reservation.id,
      phase: "PRE_TRIP",
      submittedByRole: "CUSTOMER",
      submittedById: customer.id,
      mileage: 1000,
      fuelLevel: 100,
      acceptedAt: new Date(),
      photos: { create: [{ category: "EXTERIOR", storageKey: "local:cust-ext" }] },
    },
  });

  await prisma.tripChecklist.create({ data: { reservationId: reservation.id, phase: "PICKUP", role: "HOST", step: "KEYS_RELEASED", completedById: hostUser.id } });
  return { vehicle, customer, hostUser, reservation, hostReport, customerReport };
}

describe("evaluateTripStartGate — complete happy path", () => {
  it("allows the trip to start once every precondition is satisfied", async () => {
    const { reservation } = await fullySetUpReservation();
    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.reasons).toEqual([]);
    expect(gate.canStart).toBe(true);
  });
});

describe("evaluateTripStartGate — individually missing preconditions", () => {
  it("requires key release for start but lets the host evaluate readiness before handing over keys", async () => {
    const { reservation } = await fullySetUpReservation();
    await prisma.tripChecklist.deleteMany({ where: { reservationId: reservation.id } });
    expect((await evaluateTripStartGate(reservation.id)).reasons).toContain("Host has not released the keys.");
    expect((await evaluateTripStartGate(reservation.id, prisma, "KEY_RELEASE")).canStart).toBe(true);
  });
  it("blocks the trip when the selfie-holding-license document is missing", async () => {
    const { reservation } = await fullySetUpReservation();
    await prisma.driverDocument.deleteMany({ where: { reservationId: reservation.id, type: "SELFIE_WITH_LICENSE" } });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("SELFIE_WITH_LICENSE"))).toBe(true);
  });

  it("blocks the trip when the rental payment has not succeeded", async () => {
    const { reservation } = await fullySetUpReservation(false);

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("Rental payment"))).toBe(true);
  });

  it("blocks the trip when the rental agreement has not been signed", async () => {
    const { reservation } = await fullySetUpReservation();
    await prisma.agreementAcceptance.deleteMany({ where: { reservationId: reservation.id } });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("agreement"))).toBe(true);
  });

  it("blocks the trip when the host has not completed identity handoff verification", async () => {
    const { reservation } = await fullySetUpReservation();
    await prisma.identityHandoffVerification.deleteMany({ where: { reservationId: reservation.id } });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("identity handoff"))).toBe(true);
  });

  it("blocks the trip when the customer has not accepted their pre-trip condition report", async () => {
    const { customerReport } = await fullySetUpReservation();
    await prisma.conditionReport.update({ where: { id: customerReport.id }, data: { acceptedAt: null } });

    const gate = await evaluateTripStartGate(customerReport.reservationId);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("Customer has not accepted"))).toBe(true);
  });

  it("blocks the trip when the pickup time is outside the check-in window", async () => {
    const vehicle = await createTestVehicle();
    const customer = await createTestCustomer();
    cleanupVehicleIds.push(vehicle.id);
    cleanupUserIds.push(customer.id);

    const reservation = await createTestReservation({
      vehicleId: vehicle.id,
      customerId: customer.id,
      pickupAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 days out — outside the 24h window
      returnAt: new Date(Date.now() + 13 * 24 * 60 * 60 * 1000),
      status: "DOCUMENTS_REQUIRED",
    });

    const gate = await evaluateTripStartGate(reservation.id);
    expect(gate.canStart).toBe(false);
    expect(gate.reasons.some((r) => r.includes("check-in window"))).toBe(true);
  });
});

it("blocks a fully prepared trip if a required identity document becomes quarantined", async () => {
  const { reservation } = await fullySetUpReservation();
  await prisma.driverDocument.updateMany({ where: { reservationId: reservation.id, type: "LICENSE_FRONT" }, data: { malwareScanStatus: "QUARANTINED" } });
  const gate = await evaluateTripStartGate(reservation.id);
  expect(gate.canStart).toBe(false); expect(gate.reasons).toContain("Missing clean required document: LICENSE_FRONT.");
});

it("preserves signed agreement contents while allowing the first PDF attachment", async () => {
  const { reservation } = await fullySetUpReservation();
  const acceptance = await prisma.agreementAcceptance.findFirstOrThrow({ where: { reservationId: reservation.id } });
  await expect(prisma.agreementAcceptance.update({ where: { id: acceptance.id }, data: { contentSnapshot: "altered terms" } })).rejects.toThrow();
  await prisma.agreementAcceptance.update({ where: { id: acceptance.id }, data: { signedPdfStorageKey: "local:first.pdf" } });
  await expect(prisma.agreementAcceptance.update({ where: { id: acceptance.id }, data: { signedPdfStorageKey: "local:replacement.pdf" } })).rejects.toThrow();
  expect((await prisma.agreementAcceptance.findUniqueOrThrow({ where: { id: acceptance.id } })).contentSnapshot).toBe(acceptance.contentSnapshot);
});
