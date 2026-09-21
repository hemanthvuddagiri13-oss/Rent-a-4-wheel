import { prisma } from "@/lib/prisma";
import {requireVehicleJurisdiction,visibleJurisdictions} from "@/lib/jurisdiction";
import { DURABLE_BLOCKING_STATUSES, TRANSIENT_HOLD_STATUSES } from "@/lib/reservation-state-machine";
import type { Prisma } from "@prisma/client";

/**
 * Two date ranges [aStart, aEnd) and [bStart, bEnd) overlap when
 * aStart < bEnd && bStart < aEnd.
 *
 * A reservation blocks the vehicle when either:
 *  - its status is in `DURABLE_BLOCKING_STATUSES` (CONFIRMED-and-later,
 *    plus PAYMENT_FAILED while we still hold the rental payment) — these
 *    block UNCONDITIONALLY, `expiresAt` is never consulted for them, so a
 *    stale/forgotten checkout deadline can never make a durably-blocking
 *    reservation look available; or
 *  - its status is in `TRANSIENT_HOLD_STATUSES` (CHECKOUT_HOLD,
 *    AWAITING_PAYMENT) AND its `expiresAt` is still in the future — an
 *    expired hold releases inventory immediately, in real time, even
 *    before a cleanup job has gotten around to flipping its status.
 */
export async function isVehicleAvailable(
  vehicleId: string,
  pickupAt: Date,
  returnAt: Date,
  opts: { excludeReservationId?: string; tx?: Prisma.TransactionClient } = {}
): Promise<boolean> {
  const client = opts.tx ?? prisma;
  try{await requireVehicleJurisdiction(client,vehicleId,"SEARCH");}catch{return false;}
  const now = new Date();
  if (await client.serviceCase.count({ where: { vehicleId, safetyBlock: true } })) return false;

  const overlappingReservation = await client.reservation.findFirst({
    where: {
      vehicleId,
      ...(opts.excludeReservationId ? { id: { not: opts.excludeReservationId } } : {}),
      pickupAt: { lt: returnAt },
      returnAt: { gt: pickupAt },
      OR: [
        { status: { in: DURABLE_BLOCKING_STATUSES } },
        { status: { in: TRANSIENT_HOLD_STATUSES }, expiresAt: { gt: now } },
      ],
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
    select: { status: true, isDemo: true, listingApproval: true, host: { select: { onboardingStatus: true } }, availability: { select: { isBookable: true } } },
  });
  if (!vehicle || vehicle.status !== "ACTIVE") return false;
  if (vehicle.isDemo) return false;
  if (vehicle.listingApproval !== "APPROVED" || (vehicle.host && vehicle.host.onboardingStatus !== "APPROVED")) return false;
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
        pickupAt: { lt: returnAt },
        returnAt: { gt: pickupAt },
        OR: [
          { status: { in: DURABLE_BLOCKING_STATUSES } },
          { status: { in: TRANSIENT_HOLD_STATUSES }, expiresAt: { gt: now } },
        ],
      },
      select: { vehicleId: true },
    }),
    prisma.vehicleBlock.findMany({
      where: { startAt: { lt: returnAt }, endAt: { gt: pickupAt } },
      select: { vehicleId: true },
    }),
  ]);

  const safety = await prisma.serviceCase.findMany({ where: { safetyBlock: true, vehicleId: { not: null } }, select: { vehicleId: true } });
  const unavailable = new Set([...reserved.map((r) => r.vehicleId), ...blocked.map((b) => b.vehicleId), ...safety.map(b => b.vehicleId!)]);

  const vehicles = await prisma.vehicle.findMany({
    where: {
      jurisdictionCode:{in:await visibleJurisdictions()},
      status: "ACTIVE",
      listingApproval: "APPROVED",
      isDemo: false,
      AND: [{ OR: [{ hostId: null }, { host: { onboardingStatus: "APPROVED" } }] }],
      id: { notIn: Array.from(unavailable) },
      OR: [{ availability: null }, { availability: { isBookable: true } }],
    },
    select: { id: true },
  });

  return vehicles.map((v) => v.id);
}
