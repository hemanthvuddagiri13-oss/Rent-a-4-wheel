import { fingerprint } from "@/lib/financial-operations";
import { Prisma, type PrismaClient } from "@prisma/client";
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

// Inventory acquisitions and renewals share the vehicle row lock.
export async function createOrRefreshHold(params: {
  customerId: string;
  vehicleId: string;
  pickupAt: Date;
  returnAt: Date;
  extraIds: string[];
  couponCode?: string;
}, db: PrismaClient = prisma): Promise<Reservation> {
  const { customerId, vehicleId, pickupAt, returnAt, extraIds, couponCode } = params;
  if (returnAt <= pickupAt) {
    throw new HoldError("Return date must be after pickup date.", 400);
  }

  const bookingFingerprint = fingerprint({ customerId, vehicleId, pickupAt, returnAt, extraIds: [...new Set(extraIds)].sort(), couponCode: couponCode?.trim().toUpperCase() ?? "" });
  const settings = await getSiteSettings();
  try {
    const result = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
        const now = new Date();
        const existingHold = await tx.reservation.findFirst({ where: { customerId, vehicleId, status: "CHECKOUT_HOLD" }, orderBy: { createdAt: "desc" }, include: { extras: true, coupon: true } });
        const legacyMatches = existingHold && !existingHold.bookingFingerprint && existingHold.pickupAt.getTime() === pickupAt.getTime() && existingHold.returnAt.getTime() === returnAt.getTime()
          && fingerprint(existingHold.extras.map(e => e.extraId).sort()) === fingerprint([...new Set(extraIds)].sort())
          && (existingHold.coupon?.code ?? "") === (couponCode?.trim().toUpperCase() ?? "");
        if (existingHold && (existingHold.bookingFingerprint === bookingFingerprint || legacyMatches) && existingHold.expiresAt && existingHold.expiresAt > now) {
          if (!await isVehicleAvailable(vehicleId, pickupAt, returnAt, { tx, excludeReservationId: existingHold.id })) return new HoldError("Vehicle no longer available", 409);
          return tx.reservation.update({ where: { id: existingHold.id }, data: { bookingFingerprint, expiresAt: new Date(Date.now() + HOLD_DURATION_MINUTES * 60000) } });
        }
        if (existingHold) await transitionReservation(tx, { id: existingHold.id, from: "CHECKOUT_HOLD", to: "EXPIRED", data: { expiresAt: null } });
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
          return new HoldError("This vehicle is no longer available for the selected dates.", 409);
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
            bookingFingerprint,
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

        if (existingHold) await tx.driverDocument.updateMany({ where: { reservationId: existingHold.id, userId: customerId }, data: { reservationId: reservation.id } });

        return reservation;
      },
      { maxWait: 15000, timeout: 15000 }
    );
    if (result instanceof HoldError) throw result;
    return result;
  } catch (err) {
    if (err instanceof HoldError) throw err;
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2034" || err.code === "23P01")) {
      throw new HoldError("Another booking is being processed for this vehicle. Please try again.", 409);
    }
    throw err;
  }
}
