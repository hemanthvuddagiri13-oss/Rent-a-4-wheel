import type { ConditionReportPhase, ConditionPhotoCategory } from "@prisma/client";
import type { DomainDatabase } from "@/lib/domain-transaction";
import { prisma } from "@/lib/prisma";
import { withReservationLock } from "@/lib/financial-locks";
import { tripParticipant } from "@/lib/trip-experience";
import { MarketplaceError } from "@/lib/marketplace";

export async function saveConditionReport(userId: string, reservationId: string, input: {
  phase: ConditionReportPhase; mileage: number; fuelLevel: number; damageNotes?: string | null;
  photos: Array<{ category: ConditionPhotoCategory; storageKey: string }>;
}, db: DomainDatabase = prisma) {
  return withReservationLock(reservationId, async tx => {
    const fresh = await tripParticipant(tx, userId, reservationId);
    const allowed = input.phase === "PRE_TRIP" ? ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"] : ["RETURN_IN_PROGRESS"];
    if (!allowed.includes(fresh.reservation.status)) throw new MarketplaceError("Inspection is not open for this trip phase.", 409);
    if (await tx.conditionReport.findFirst({ where: { reservationId, phase: input.phase, submittedByRole: fresh.role } })) throw new MarketplaceError("A report already exists for this party and phase. Review the saved report.", 409);
    const report = await tx.conditionReport.create({ data: { reservationId, phase: input.phase, submittedByRole: fresh.role, submittedById: userId, mileage: input.mileage, fuelLevel: input.fuelLevel, damageNotes: input.damageNotes || null, photos: { create: input.photos } } });
    await tx.tripEvent.create({ data: { reservationId, type: "CONDITION_REPORT_SUBMITTED", actorId: userId, metadata: { phase: input.phase, role: fresh.role, conditionReportId: report.id } } });
    return { id: report.id };
  }, db);
}
export async function acceptConditionReport(userId: string, reservationId: string, reportId: string, db: DomainDatabase = prisma) {
  return withReservationLock(reservationId, async tx => {
    const { reservation } = await tripParticipant(tx, userId, reservationId);
    const report = await tx.conditionReport.findFirst({ where: { id: reportId, reservationId } });
    if (!report) throw new MarketplaceError("Not found", 404);
    if (report.submittedById !== userId) throw new MarketplaceError("Only the report's author can accept it.", 403);
    if (report.acceptedAt) return { success: true, alreadyAccepted: true };
    const allowed = report.phase === "PRE_TRIP" ? ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"] : ["RETURN_IN_PROGRESS"];
    if (!allowed.includes(reservation.status)) throw new MarketplaceError("Inspection phase closed", 409);
    await tx.conditionReport.update({ where: { id: reportId }, data: { acceptedAt: new Date() } });
    await tx.tripEvent.create({ data: { reservationId, type: "CONDITION_REPORT_ACCEPTED", actorId: userId, metadata: { conditionReportId: reportId } } });
    return { success: true, alreadyAccepted: false };
  }, db);
}
