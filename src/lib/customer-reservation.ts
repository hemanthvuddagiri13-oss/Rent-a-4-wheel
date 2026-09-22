import type { ReservationStatus } from "@prisma/client";
import type { DomainDatabase } from "@/lib/domain-transaction";
import { prisma } from "@/lib/prisma";
import { withReservationLock } from "@/lib/financial-locks";
import { tripParticipant } from "@/lib/trip-experience";
import { MarketplaceError } from "@/lib/marketplace";
import { canCustomerCancel } from "@/lib/reservation-rules";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { enqueueOutboxNotification } from "@/lib/outbox";

export async function cancelCustomerReservation(userId: string, id: string, db: DomainDatabase = prisma) {
  return withReservationLock(id, async tx => {
    const owner = await tx.reservation.findUniqueOrThrow({ where: { id }, select: { customerId: true } });
    if (owner.customerId !== userId) throw new MarketplaceError("Customer access required.", 403);
    const { reservation, role } = await tripParticipant(tx, userId, id);
    if (role !== "CUSTOMER") throw new MarketplaceError("Customer access required.", 403);
    if (reservation.status === "CANCELLED_BY_CUSTOMER") return { success: true };
    const eligibility = canCustomerCancel(reservation);
    if (!eligibility.allowed) throw new MarketplaceError(eligibility.reason ?? "Cancellation unavailable.", 409);
    await transitionReservation(tx, { id, from: reservation.status, to: "CANCELLED_BY_CUSTOMER", data: { expiresAt: null } });
    await tx.auditLog.create({ data: { actorId: userId, action: "reservation.cancel", entityType: "Reservation", entityId: id, metadata: { initiatedBy: "customer" } } });
    await tx.tripEvent.create({ data: { reservationId: id, type: "CANCELLED_BY_CUSTOMER", actorId: userId } });
    await enqueueOutboxNotification(tx, { userId, reservationId: id, type: "CANCELLATION" }, `customer-cancel:${id}`);
    return { success: true };
  }, db);
}

const PRE_TRIP_CHAIN: ReservationStatus[] = ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START", "ACTIVE"];
export async function startCustomerTrip(userId: string, id: string, db: DomainDatabase = prisma) {
  return withReservationLock(id, async tx => {
    const owner = await tx.reservation.findUniqueOrThrow({ where: { id }, select: { customerId: true } });
    if (owner.customerId !== userId) throw new MarketplaceError("Customer access required.", 403);
    const { reservation, role } = await tripParticipant(tx, userId, id);
    if (role !== "CUSTOMER") throw new MarketplaceError("Customer access required.", 403);
    const index = PRE_TRIP_CHAIN.indexOf(reservation.status);
    if (index < 0 || index === PRE_TRIP_CHAIN.length - 1) throw new MarketplaceError("Trip is not awaiting start.", 409);
    const gate = await evaluateTripStartGate(id, tx);
    if (!gate.canStart) throw new MarketplaceError("Trip requirements are incomplete.", 409);
    const report = await tx.conditionReport.findFirst({ where: { reservationId: id, phase: "PRE_TRIP", submittedByRole: "HOST" } });
    let current = reservation.status;
    for (let i = index; i < PRE_TRIP_CHAIN.length - 1; i++) {
      const next = PRE_TRIP_CHAIN[i + 1];
      await transitionReservation(tx, { id, from: current, to: next }); current = next;
    }
    const data = { startedAt: new Date(), startedByUserId: userId, startMileage: report?.mileage, startFuelLevel: report?.fuelLevel };
    await tx.trip.upsert({ where: { reservationId: id }, create: { reservationId: id, ...data }, update: data });
    await tx.tripEvent.create({ data: { reservationId: id, type: "TRIP_STARTED", actorId: userId } });
    return { success: true };
  }, db);
}
