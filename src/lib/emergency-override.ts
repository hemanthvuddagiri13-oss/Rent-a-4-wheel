import { prisma } from "@/lib/prisma";
import { verifyAuthCode } from "@/lib/auth-code";
import { canPerformEmergencyOverride } from "@/lib/rbac";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { queueNotification } from "@/lib/notifications";
import type { ReservationStatus } from "@prisma/client";

const MIN_REASON_LENGTH = 10;

export class EmergencyOverrideError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type EmergencyOverrideAction = "FORCE_START_TRIP" | "FORCE_COMPLETE_TRIP";

const RESULTING_STATUS: Record<EmergencyOverrideAction, ReservationStatus> = {
  FORCE_START_TRIP: "ACTIVE",
  FORCE_COMPLETE_TRIP: "COMPLETED",
};

/**
 * The only path by which a reservation may skip an unmet Start
 * Trip / Return gate. Never exposed as an ordinary admin action — every
 * call requires:
 *   - the actor to hold the SUPER_ADMIN role (not ADMIN, not STAFF),
 *   - a step-up email-code verification completed in the last few
 *     minutes (the closest equivalent to "recent MFA" available in this
 *     system — no TOTP/WebAuthn factor exists yet, documented as a
 *     scoping decision rather than silently substituted),
 *   - a mandatory written reason,
 *   - an explicit `confirm: true` from the caller (the confirmation
 *     step — a real admin UI would show this as an "are you sure" modal
 *     before setting it),
 * and leaves an immutable EmergencyOverrideRecord (original + resulting
 * status, every unmet gate reason at the time of the override, actor,
 * timestamp) plus notifies both the customer and the host.
 */
export async function performEmergencyOverride(params: {
  actorId: string;
  actorRole: string;
  actorEmail: string;
  reservationId: string;
  action: EmergencyOverrideAction;
  reason: string;
  stepUpCode: string;
  confirm: boolean;
  ip: string | null;
}): Promise<{ id: string; resultingStatus: ReservationStatus }> {
  const actor = await prisma.user.findUnique({ where: { id: params.actorId } });
  if (!actor?.isActive || actor.email !== params.actorEmail || !canPerformEmergencyOverride(actor.role) || !canPerformEmergencyOverride(params.actorRole)) {
    throw new EmergencyOverrideError("Only a super administrator may perform an emergency override.", 403);
  }
  if (!params.confirm) {
    throw new EmergencyOverrideError("This action requires explicit confirmation (confirm: true).", 400);
  }
  if (params.reason.trim().length < MIN_REASON_LENGTH) {
    throw new EmergencyOverrideError(`A written reason of at least ${MIN_REASON_LENGTH} characters is required.`, 400);
  }

  const stepUpResult = await verifyAuthCode({ email: params.actorEmail, code: params.stepUpCode, ip: params.ip });
  if (!stepUpResult.ok) {
    throw new EmergencyOverrideError("Step-up verification failed — request a fresh code and try again.", 403);
  }
  const stepUpVerifiedAt = new Date();

  const reservation = await prisma.reservation.findUnique({
    where: { id: params.reservationId },
    include: { vehicle: { include: { host: true } } },
  });
  if (!reservation) {
    throw new EmergencyOverrideError("Reservation not found.", 404);
  }

  const gate = await evaluateTripStartGate(params.reservationId);
  const resultingStatus = RESULTING_STATUS[params.action];
  const originalStatus = reservation.status;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${params.actorId} FOR UPDATE`;
    const currentActor = await tx.user.findUniqueOrThrow({ where: { id: params.actorId } });
    if (!currentActor.isActive || currentActor.role !== "SUPER_ADMIN" || currentActor.email !== params.actorEmail) throw new EmergencyOverrideError("Emergency override authority was revoked.", 403);
    await transitionReservation(tx, {
      id: reservation.id,
      from: originalStatus,
      to: resultingStatus,
      force: true,
    });

    if (params.action === "FORCE_START_TRIP") await tx.trip.upsert({ where: { reservationId: reservation.id }, create: { reservationId: reservation.id, startedAt: new Date(), startedByUserId: params.actorId }, update: { startedAt: new Date(), startedByUserId: params.actorId } });
    else await tx.trip.updateMany({ where: { reservationId: reservation.id, endedAt: null }, data: { endedAt: new Date() } });

    await tx.emergencyOverrideRecord.create({
      data: {
        reservationId: reservation.id,
        actorId: params.actorId,
        action: params.action,
        reason: params.reason,
        originalStatus,
        resultingStatus,
        unmetGateReasons: gate.reasons,
        stepUpVerifiedAt,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: params.actorId,
        action: `reservation.emergency_override.${params.action.toLowerCase()}`,
        entityType: "Reservation",
        entityId: reservation.id,
        metadata: { originalStatus, resultingStatus, unmetGateReasons: gate.reasons, reason: params.reason },
      },
    });

    await tx.tripEvent.create({
      data: {
        reservationId: reservation.id,
        type: "EMERGENCY_OVERRIDE",
        actorId: params.actorId,
        metadata: { action: params.action, originalStatus, resultingStatus, unmetGateReasons: gate.reasons },
      },
    });
  });

  await queueNotification({
    userId: reservation.customerId,
    reservationId: reservation.id,
    type: "TRIP_EMERGENCY_OVERRIDE",
    extra: { action: params.action },
  });
  if (reservation.vehicle.host) {
    await queueNotification({
      userId: reservation.vehicle.host.userId,
      reservationId: reservation.id,
      type: "TRIP_EMERGENCY_OVERRIDE",
      extra: { action: params.action },
    });
  }

  return { id: reservation.id, resultingStatus };
}
