import { prisma } from "@/lib/prisma";
import { BLOCKING_RESERVATION_STATUSES } from "@/lib/reservation-state-machine";
import type { Prisma } from "@prisma/client";

/**
 * Two date ranges [aStart, aEnd) and [bStart, bEnd) overlap when
 * aStart < bEnd && bStart < aEnd.
 *
 * A reservation only actually blocks the vehicle while its status is in
 * `BLOCKING_RESERVATION_STATUSES` AND (for the two hold-phase statuses,
 * CHECKOUT_HOLD/AWAITING_PAYMENT) its `expiresAt` hasn't passed yet — an
 * expired hold releases inventory immediately, in real time, even before a
 * cleanup job has gotten around to flipping its status to EXPIRED.
 */
export async function isVehicleAvailable(
  vehicleId: string,
  pickupAt: Date,
  returnAt: Date,
  opts: { excludeReservationId?: string; tx?: Prisma.TransactionClient } = {}
): Promise<boolean> {
  const client = opts.tx ?? prisma;
  const now = new Date();

  const overlappingReservation = await client.reservation.findFirst({
    where: {
      vehicleId,
      status: { in: BLOCKING_RESERVATION_STATUSES },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(opts.excludeReservationId ? { id: { not: opts.excludeReservationId } } : {}),
      pickupAt: { lt: returnAt },
      returnAt: { gt: pickupAt },
    },
    select: { id: true },
  });
  if (overlappingReservation) return false;

  const overlappingBlock = await client.vehicleBlock.findFirst({
    where: {
      vehicleId,
      startAt: { lt: returnAt },
      endAt: { gt: pickupAt },
    },
    select: { id: true },
  });
  if (overlappingBlock) return false;

  const vehicle = await client.vehicle.findUnique({
    where: { id: vehicleId },
    select: { status: true, availability: { select: { isBookable: true } } },
  });
  if (!vehicle || vehicle.status !== "ACTIVE") return false;
  if (vehicle.availability && !vehicle.availability.isBookable) return false;

  return true;
}

export async function getAvailableVehicleIds(
  pickupAt: Date,
  returnAt: Date
): Promise<string[]> {
  const now = new Date();
  const [reserved, blocked] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        status: { in: BLOCKING_RESERVATION_STATUSES },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        pickupAt: { lt: returnAt },
        returnAt: { gt: pickupAt },
      },
      select: { vehicleId: true },
    }),
    prisma.vehicleBlock.findMany({
      where: { startAt: { lt: returnAt }, endAt: { gt: pickupAt } },
      select: { vehicleId: true },
    }),
  ]);

  const unavailable = new Set([...reserved.map((r) => r.vehicleId), ...blocked.map((b) => b.vehicleId)]);

  const vehicles = await prisma.vehicle.findMany({
    where: {
      status: "ACTIVE",
      id: { notIn: Array.from(unavailable) },
      OR: [{ availability: null }, { availability: { isBookable: true } }],
    },
    select: { id: true },
  });

  return vehicles.map((v) => v.id);
}
