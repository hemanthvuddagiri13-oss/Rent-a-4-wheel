import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, createTestCustomer, createTestReservation, createTestVehicle, cleanupReservationsForVehicles } from "./helpers/factories";
import { fingerprint } from "@/lib/financial-operations";
import { withReservationLock } from "@/lib/financial-locks";
import { upgradeBookingFingerprint } from "@/lib/booking-fingerprint";
const vehicles: string[] = [], users: string[] = [];
afterAll(async () => { await cleanupReservationsForVehicles(vehicles); await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.$disconnect(); });
describe("legacy fingerprint fail-closed validation", () => {
  it.each(["wrong tuple", "missing draft", "inconsistent price", "financial activity"])("does not rewrite %s", async failure => {
    const v = await createTestVehicle(), u = await createTestCustomer(); vehicles.push(v.id); users.push(u.id);
    const r = await createTestReservation({ vehicleId: v.id, customerId: u.id, pickupAt: new Date("2035-01-01"), returnAt: new Date("2035-01-04"), expiresAt: new Date(Date.now() + 900000) });
    const old = fingerprint({ customerId: u.id, vehicleId: v.id, pickupAt: r.pickupAt, returnAt: r.returnAt, extraIds: [], couponCode: "" });
    await prisma.reservation.update({ where: { id: r.id }, data: { bookingFingerprintVersion: 1, bookingFingerprint: failure === "wrong tuple" ? "incorrect" : old, ...(failure === "inconsistent price" ? { totalCents: 1 } : {}) } });
    if (failure !== "missing draft") await prisma.bookingDraft.create({ data: { id: randomUUID(), customerId: u.id, vehicleId: v.id, reservationId: r.id, fingerprint: failure === "wrong tuple" ? "incorrect" : old, fingerprintVersion: 1, revision: 4 } });
    if (failure === "financial activity") await prisma.payment.create({ data: { reservationId: r.id, type: "RENTAL", amountCents: 15000 } });
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    const drafts = await prisma.bookingDraft.findMany({ where: { reservationId: r.id } });
    await expect(withReservationLock(r.id, tx => upgradeBookingFingerprint(tx, r.id))).rejects.toThrow();
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toEqual(before);
    expect(await prisma.bookingDraft.findMany({ where: { reservationId: r.id } })).toEqual(drafts);
  });
});
