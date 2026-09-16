import { Prisma } from "@prisma/client";
import type { Reservation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isVehicleAvailable } from "@/lib/availability";
import { calculatePricing, isCouponValid } from "@/lib/pricing";
import { getSiteSettings } from "@/lib/settings";
import { generateConfirmationNumber } from "@/lib/confirmation";
import { transitionReservation } from "@/lib/reservation-state-machine";

export const HOLD_DURATION_MINUTES = 15;

export class HoldError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Places (or refreshes) a 15-minute checkout hold for a customer on a
 * specific vehicle/date range.
 *
 * An existing CHECKOUT_HOLD row for the same (customer, vehicle, dates)
 * is only ever *refreshed* while it is still genuinely live
 * (`expiresAt > now`). If it has already expired, it is first explicitly
 * transitioned to EXPIRED and committed on its own — releasing it for
 * good regardless of what happens next — and only then does a fresh,
 * serializable-transaction availability check run before a brand-new
 * hold is created. The vehicle may have been booked by someone else in
 * the meantime, in which case this correctly fails with a conflict
 * rather than silently handing the customer back dates that are no
 * longer theirs — and the expired hold stays released either way.
 */
export async function createOrRefreshHold(params: {
  customerId: string;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  extraIds: string[];
  couponCode?: string;
}): Promise<Reservation> {
  const { customerId, vehicleId, pickupAt, returnAt, extraIds, couponCode } = params;
  if (returnAt <= pickupAt) {
    throw new HoldError("Return date must be after pickup date.", 400);
  }

  const now = new Date();
  const existingHold = await prisma.reservation.findFirst({
    where: { customerId, vehicleId, pickupAt, returnAt, status: "CHECKOUT_HOLD" },
  });

  if (existingHold && existingHold.expiresAt && existingHold.expiresAt > now) {
    // Still genuinely live — simple refresh, no availability re-check
    // needed since this row already legitimately occupies the slot.
    return prisma.reservation.update({
      where: { id: existingHold.id },
      data: { expiresAt: new Date(now.getTime() + HOLD_DURATION_MINUTES * 60 * 1000) },
    });
  }

  if (existingHold) {
    // Expired but not yet swept by the background cleanup job — release
    // it explicitly, as its OWN committed step, before attempting
    // anything else. This must be a separate, already-committed step
    // (not part of the transaction below): if the availability check that
    // follows finds the dates are gone, we still must not leave this
    // stale hold sitting in CHECKOUT_HOLD — that would silently keep
    // blocking the vehicle for everyone, including whoever legitimately
    // holds the dates now, for another 15 minutes.
    try {
      await prisma.$transaction(async (tx) => {
        await transitionReservation(tx, {
          id: existingHold.id,
          from: "CHECKOUT_HOLD",
          to: "EXPIRED",
          data: { expiresAt: null },
        });
        await tx.tripEvent.create({ data: { reservationId: existingHold.id, type: "HOLD_EXPIRED_ON_REFRESH_ATTEMPT" } });
      });
    } catch {
      // Already transitioned by a concurrent request/the cleanup job —
      // fine, proceed to the availability check below regardless.
    }
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle || vehicle.status !== "ACTIVE") {
          throw new HoldError("This vehicle is not currently available.", 404);
        }

        // Fresh availability check in its own transaction — the
        // now-released expired hold above no longer blocks, but someone
        // else may have confirmed a booking for these exact dates while
        // it sat expired-but-unswept.
        const available = await isVehicleAvailable(vehicleId, pickupAt, returnAt, { tx });
        if (!available) {
          throw new HoldError("This vehicle is no longer available for the selected dates.", 409);
        }

        const extras = extraIds.length
          ? await tx.extra.findMany({ where: { id: { in: extraIds }, isActive: true } })
          : [];

        let coupon = null;
        if (couponCode) {
          const found = await tx.coupon.findUnique({ where: { code: couponCode.toUpperCase() } });
          const days = Math.max(1, Math.ceil((returnAt.getTime() - pickupAt.getTime()) / 86_400_000));
          if (found) {
            const validity = isCouponValid(found, { rentalDays: days, vehicleId });
            if (validity.valid) coupon = found;
          }
        }

        const settings = await getSiteSettings();
        const breakdown = calculatePricing({
          vehicle,
          pickupAt,
          returnAt,
          extras: extras.map((extra) => ({ extra, quantity: 1 })),
          coupon,
          taxRatePercent: settings.taxRatePercent,
        });

        const expiresAt = new Date(now.getTime() + HOLD_DURATION_MINUTES * 60 * 1000);

        const reservation = await tx.reservation.create({
          data: {
            confirmationNumber: generateConfirmationNumber(),
            customerId,
            vehicleId,
            pickupAt,
            returnAt,
            rateType: breakdown.rateType,
            rateAmountCents: breakdown.rateAmountCents,
            units: breakdown.units,
            subtotalCents: breakdown.subtotalCents,
            taxCents: breakdown.taxCents,
            feesCents: breakdown.feesCents,
            discountCents: breakdown.discountCents,
            extrasCents: breakdown.extrasCents,
            totalCents: breakdown.totalCents,
            depositCents: breakdown.depositCents,
            couponId: coupon?.id,
            status: "CHECKOUT_HOLD",
            expiresAt,
            extras: {
              create: breakdown.extraLineItems.map((line) => ({
                extraId: line.extraId,
                quantity: line.quantity,
                amountCents: line.amountCents,
              })),
            },
            ...(vehicle.securityDepositCents > 0
              ? { deposit: { create: { amountCents: vehicle.securityDepositCents, status: "REQUIRES_PAYMENT" } } }
              : {}),
          },
        });

        await tx.tripEvent.create({
          data: { reservationId: reservation.id, type: "CHECKOUT_HOLD_CREATED", actorId: customerId },
        });

        return reservation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (err) {
    if (err instanceof HoldError) throw err;
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2034" || err.code === "23P01")) {
      throw new HoldError("Another booking is being processed for this vehicle. Please try again.", 409);
    }
    throw err;
  }
}
