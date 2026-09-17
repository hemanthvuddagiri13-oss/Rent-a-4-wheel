import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { marketplaceActor, marketplaceHost, MarketplaceError } from "@/lib/marketplace";
import { withReservationLock } from "@/lib/financial-locks";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { planAllDepositReleases } from "@/lib/deposit-release-plan";

export async function tripParticipant(tx: Prisma.TransactionClient, userId: string, reservationId: string) {
  await marketplaceActor(tx, userId);
  const reservation = await tx.reservation.findUnique({ where: { id: reservationId }, include: { vehicle: true } });
  if (!reservation) throw new MarketplaceError("Reservation unavailable.", 404);
  if (reservation.customerId === userId) return { reservation, role: "CUSTOMER" as const };
  const { host } = await marketplaceHost(tx, userId);
  if (reservation.vehicle.hostId !== host.id) throw new MarketplaceError("Reservation unavailable.", 404);
  return { reservation, role: "HOST" as const };
}

export async function tripCommand(userId: string, id: string, action: "keys" | "return" | "complete") {
  return withReservationLock(id, async tx => {
    const { reservation: r, role } = await tripParticipant(tx, userId, id);
    if (action === "keys") {
      if (role !== "HOST") throw new MarketplaceError("Only the assigned host can release keys.", 403);
      const gate = await evaluateTripStartGate(id, tx, "KEY_RELEASE");
      if (!gate.canStart) throw new MarketplaceError(gate.reasons.join(" "), 409);
      await tx.tripChecklist.upsert({ where: { reservationId_phase_role_step: { reservationId: id, phase: "PICKUP", role: "HOST", step: "KEYS_RELEASED" } }, create: { reservationId: id, phase: "PICKUP", role: "HOST", step: "KEYS_RELEASED", completedById: userId }, update: {} });
    }
    if (action === "return") {
      if (r.status === "RETURN_IN_PROGRESS") return { success: true };
      if (r.status !== "ACTIVE") throw new MarketplaceError("Only an active trip can begin return.", 409);
      await transitionReservation(tx, { id, from: "ACTIVE", to: "RETURN_IN_PROGRESS" });
    }
    if (action === "complete") {
      if (role !== "HOST") throw new MarketplaceError("The assigned host completes the return inspection.", 403);
      if (r.status === "COMPLETED") return { success: true };
      if (r.status !== "RETURN_IN_PROGRESS") throw new MarketplaceError("Begin the return before completing it.", 409);
      const reports = await tx.conditionReport.findMany({ where: { reservationId: id, phase: "POST_TRIP", acceptedAt: { not: null } }, include: { photos: true } });
      const customer = reports.find(report => report.submittedByRole === "CUSTOMER" && report.submittedById === r.customerId);
      const host = reports.find(report => report.submittedByRole === "HOST");
      if (!customer || !host || [customer, host].some(report => !report.photos.some(p => p.category === "EXTERIOR") || !report.photos.some(p => p.category === "INTERIOR"))) throw new MarketplaceError("Both parties must accept return reports with exterior and interior photos.", 409);
      const trip = await tx.trip.findUnique({ where: { reservationId: id } });
      if (!trip?.startedAt || host.mileage < (trip.startMileage ?? 0) || customer.mileage < (trip.startMileage ?? 0)) throw new MarketplaceError("Return odometer cannot precede pickup.", 409);
      if (host.damageNotes?.trim() || customer.damageNotes?.trim()) {
        await tx.damageReport.create({ data: { reservationId: id, description: [host.damageNotes, customer.damageNotes].filter(Boolean).join("\n"), photoUrls: [] } });
        await transitionReservation(tx, { id, from: "RETURN_IN_PROGRESS", to: "DISPUTED" });
      } else {
        await transitionReservation(tx, { id, from: "RETURN_IN_PROGRESS", to: "COMPLETED", data: { financialDisposition: "TERMINATED" } });
        await planAllDepositReleases(tx, id);
      }
      await tx.trip.update({ where: { reservationId: id }, data: { endedAt: new Date(), endedByUserId: userId, endMileage: host.mileage, endFuelLevel: host.fuelLevel } });
      await tx.vehicle.update({ where: { id: r.vehicleId }, data: { mileage: Math.max(r.vehicle.mileage, host.mileage) } });
      await tx.tripEvent.create({ data: { reservationId: id, actorId: userId, type: "RETURN_REVIEWED", metadata: { lateReturn: new Date() > r.returnAt, milesDriven: host.mileage - (trip.startMileage ?? host.mileage), fuelDifference: host.fuelLevel - (trip.startFuelLevel ?? host.fuelLevel), damageReviewRequired: Boolean(host.damageNotes?.trim() || customer.damageNotes?.trim()) } } });
    }
    await tx.tripEvent.create({ data: { reservationId: id, actorId: userId, type: `TRIP_${action.toUpperCase()}` } });
    return { success: true };
  });
}

export async function tripExperience(userId: string, id: string) {
  const { role } = await tripParticipant(prisma, userId, id);
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: {
    vehicle: { select: { year: true, make: true, model: true } },
    documents: { where: { deletedAt: null }, select: { id: true, type: true, status: true, malwareScanStatus: true } },
    conditionReports: { include: { photos: { select: { id: true, category: true } } }, orderBy: { createdAt: "asc" } },
    identityHandoff: { select: { verifiedAt: true } }, trip: true,
    tripChecklistEntries: { select: { step: true, completedAt: true } },
    tripEvents: { select: { id: true, type: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 30 },
  } });
  return { id, role, observedAt: new Date(), status: r.status, confirmationNumber: r.confirmationNumber, vehicle: r.vehicle,
    pickupAt: r.pickupAt, returnAt: r.returnAt, bookingTimezone: r.bookingTimezone, pickupLocation: r.pickupLocation,
    documents: r.documents, reports: r.conditionReports.map(report => ({ id: report.id, phase: report.phase, role: report.submittedByRole, own: report.submittedById === userId, acceptedAt: report.acceptedAt, mileage: report.mileage, fuelLevel: report.fuelLevel, damageNotes: report.damageNotes, photos: report.photos })),
    handoffVerified: Boolean(r.identityHandoff?.verifiedAt), keysReleased: r.tripChecklistEntries.some(s => s.step === "KEYS_RELEASED"),
    trip: r.trip ? { startedAt: r.trip.startedAt, endedAt: r.trip.endedAt, startMileage: r.trip.startMileage, endMileage: r.trip.endMileage, startFuelLevel: r.trip.startFuelLevel, endFuelLevel: r.trip.endFuelLevel } : null,
    events: r.tripEvents, gate: await evaluateTripStartGate(id) };
}
