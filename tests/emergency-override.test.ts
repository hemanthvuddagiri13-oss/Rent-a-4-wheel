import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { performEmergencyOverride, EmergencyOverrideError } from "@/lib/emergency-override";
import {
  prisma,
  createTestVehicle,
  createTestCustomer,
  createTestReservation,
  cleanupReservationsForVehicles,
  uniqueEmail,
} from "./helpers/factories";

const cleanupVehicleIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  await cleanupReservationsForVehicles(cleanupVehicleIds);
  await prisma.vehicle.deleteMany({ where: { id: { in: cleanupVehicleIds } } });
  await prisma.authCode.deleteMany({ where: { email: { contains: "emergency-override" } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function setupReservationAndActor(role: "ADMIN" | "SUPER_ADMIN") {
  const vehicle = await createTestVehicle();
  const customer = await createTestCustomer();
  const actorEmail = uniqueEmail("emergency-override");
  const actor = await prisma.user.create({ data: { email: actorEmail, role } });
  cleanupVehicleIds.push(vehicle.id);
  cleanupUserIds.push(customer.id, actor.id);

  const reservation = await createTestReservation({
    vehicleId: vehicle.id,
    customerId: customer.id,
    pickupAt: new Date(Date.now() + 60 * 60 * 1000),
    returnAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
    status: "DOCUMENTS_REQUIRED",
  });

  return { vehicle, customer, actor, reservation };
}

async function issueValidStepUpCode(email: string): Promise<string> {
  const code = "123456";
  const codeHash = await bcrypt.hash(code, 4);
  await prisma.authCode.create({
    data: { email: email.toLowerCase(), purpose: "SIGN_IN", codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });
  return code;
}

describe("emergency override — unauthorized force-start attempts are all rejected", () => {
  it("rejects an ordinary ADMIN (not SUPER_ADMIN)", async () => {
    const { actor, reservation } = await setupReservationAndActor("ADMIN");
    const code = await issueValidStepUpCode(actor.email);

    await expect(
      performEmergencyOverride({
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        reservationId: reservation.id,
        action: "FORCE_START_TRIP",
        reason: "Testing unauthorized admin role.",
        stepUpCode: code,
        confirm: true,
        ip: null,
      })
    ).rejects.toThrow(EmergencyOverrideError);

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED"); // untouched
  });

  it("rejects a SUPER_ADMIN without a valid step-up code", async () => {
    const { actor, reservation } = await setupReservationAndActor("SUPER_ADMIN");

    await expect(
      performEmergencyOverride({
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        reservationId: reservation.id,
        action: "FORCE_START_TRIP",
        reason: "Testing missing step-up verification.",
        stepUpCode: "000000",
        confirm: true,
        ip: null,
      })
    ).rejects.toThrow(EmergencyOverrideError);

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("DOCUMENTS_REQUIRED");
  });

  it("rejects a SUPER_ADMIN with a valid step-up code but no confirmation", async () => {
    const { actor, reservation } = await setupReservationAndActor("SUPER_ADMIN");
    const code = await issueValidStepUpCode(actor.email);

    await expect(
      performEmergencyOverride({
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        reservationId: reservation.id,
        action: "FORCE_START_TRIP",
        reason: "Testing missing confirmation.",
        stepUpCode: code,
        confirm: false,
        ip: null,
      })
    ).rejects.toThrow(EmergencyOverrideError);
  });

  it("rejects a SUPER_ADMIN with a blank/too-short reason", async () => {
    const { actor, reservation } = await setupReservationAndActor("SUPER_ADMIN");
    const code = await issueValidStepUpCode(actor.email);

    await expect(
      performEmergencyOverride({
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        reservationId: reservation.id,
        action: "FORCE_START_TRIP",
        reason: "short",
        stepUpCode: code,
        confirm: true,
        ip: null,
      })
    ).rejects.toThrow(EmergencyOverrideError);
  });

  it("succeeds for a SUPER_ADMIN with role + step-up + reason + confirmation, and leaves a full audit record", async () => {
    const { actor, reservation } = await setupReservationAndActor("SUPER_ADMIN");
    await prisma.payment.create({ data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: reservation.totalCents } });
    const code = await issueValidStepUpCode(actor.email);

    const result = await performEmergencyOverride({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      reservationId: reservation.id,
      action: "FORCE_START_TRIP",
      reason: "Customer stranded at pickup counter, documents pending IT outage — verified identity in person.",
      stepUpCode: code,
      confirm: true,
      ip: "203.0.113.5",
    });

    expect(result.resultingStatus).toBe("ACTIVE");

    const reloaded = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reloaded.status).toBe("ACTIVE");

    const record = await prisma.emergencyOverrideRecord.findFirstOrThrow({ where: { reservationId: reservation.id } });
    expect(record.actorId).toBe(actor.id);
    expect(record.originalStatus).toBe("DOCUMENTS_REQUIRED");
    expect(record.resultingStatus).toBe("ACTIVE");
    expect(Array.isArray(record.unmetGateReasons)).toBe(true);
    expect((record.unmetGateReasons as string[]).length).toBeGreaterThan(0);
    expect(record.stepUpVerifiedAt).toBeInstanceOf(Date);
  });
});

it("rejects a revoked super-admin role even when supplied session claims are stale", async () => {
  const { actor, reservation } = await setupReservationAndActor("SUPER_ADMIN");
  const code = await issueValidStepUpCode(actor.email);
  await prisma.user.update({ where: { id: actor.id }, data: { role: "CUSTOMER" } });
  await expect(performEmergencyOverride({ actorId: actor.id, actorRole: "SUPER_ADMIN", actorEmail: actor.email, reservationId: reservation.id, action: "FORCE_START_TRIP", reason: "Stale role cannot authorize an emergency action", stepUpCode: code, confirm: true, ip: null })).rejects.toThrow("super administrator");
  expect(await prisma.emergencyOverrideRecord.count({ where: { reservationId: reservation.id } })).toBe(0);
});
