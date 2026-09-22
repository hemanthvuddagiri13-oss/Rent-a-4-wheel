import { domainTransaction, type DomainDatabase } from "@/lib/domain-transaction";
import { requireReleaseFeature } from "@/lib/release-control";
import { releaseAuthorityFence } from "@/lib/admission-authority";
import {requireVehicleJurisdiction} from "@/lib/jurisdiction";
import { financeQuote } from "@/lib/finance-rules";
import { bookingDays } from "@/lib/booking-time";
import { upgradeBookingFingerprint } from "@/lib/booking-fingerprint";
import { fingerprint, json } from "@/lib/financial-operations";
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

// Inventory acquisitions and renewals share the vehicle row lock.
export async function createOrRefreshHold(params: {
  customerId: string;
  vehicleId: string;
  bookingTimezone?: string;
  pickupAt: Date;
  returnAt: Date;
  extraIds: string[];
  couponCode?: string;
  draftId?: string;
  revision?: number;
}, db: DomainDatabase = prisma): Promise<Reservation> {
  const { customerId, vehicleId, pickupAt, returnAt, extraIds, couponCode } = params;
  if (returnAt <= pickupAt) {
    throw new HoldError("Return date must be after pickup date.", 400);
  }

  const settings = await getSiteSettings();
  const bookingTimezone = params.bookingTimezone ?? settings.bookingTimezone;
  const bookingFingerprint = fingerprint({ customerId, vehicleId, bookingTimezone, pickupAt, returnAt, extraIds: [...new Set(extraIds)].sort(), couponCode: couponCode?.trim().toUpperCase() ?? "" });
  try {
    const result = await domainTransaction(db, 
      async (tx) => {
        await releaseAuthorityFence(tx);
        await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + vehicleId})`;
        await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
        const jurisdiction=await requireVehicleJurisdiction(tx,vehicleId,"CHECKOUT");
        await requireReleaseFeature("booking",tx,jurisdiction.code);
        if (params.draftId) {
          let draft = await tx.bookingDraft.upsert({ where: { id: params.draftId }, update: {}, create: { id: params.draftId, customerId, vehicleId } });
          if (draft.customerId !== customerId || draft.vehicleId !== vehicleId) throw new HoldError("Booking draft unavailable", 403);
          if (draft.reservationId) {
            await upgradeBookingFingerprint(tx, draft.reservationId);
            draft = await tx.bookingDraft.findUniqueOrThrow({ where: { id: draft.id } });
          }
          if (!params.revision || params.revision < draft.revision || (params.revision === draft.revision && draft.fingerprint !== bookingFingerprint)) throw new HoldError("Obsolete booking revision", 409);
          if (draft.reservationId) {
            const prior = await tx.reservation.findUnique({ where: { id: draft.reservationId } });
            if (prior?.checkoutFingerprint) {
              if (draft.fingerprint === bookingFingerprint) return prior;
              throw new HoldError("Checkout is immutable; resume the existing reservation", 409);
            }
          }
          await tx.bookingDraft.update({ where: { id: draft.id }, data: { revision: params.revision, fingerprint: bookingFingerprint, fingerprintVersion: 2 } });
        }
        const now = new Date();
        const existingHold = await tx.reservation.findFirst({ where: { customerId, vehicleId, status: "CHECKOUT_HOLD" }, orderBy: { createdAt: "desc" }, include: { extras: true, coupon: true } });
        if (params.draftId && existingHold) {
          const ownerDraft = await tx.bookingDraft.findFirst({ where: { reservationId: existingHold.id, id: { not: params.draftId } } });
          if (ownerDraft) throw new HoldError("Resume your existing booking before changing these dates", 409);
        }
        const legacyMatches = existingHold && !existingHold.bookingFingerprint && existingHold.pickupAt.getTime() === pickupAt.getTime() && existingHold.returnAt.getTime() === returnAt.getTime()
          && fingerprint(existingHold.extras.map(e => e.extraId).sort()) === fingerprint([...new Set(extraIds)].sort())
          && (existingHold.coupon?.code ?? "") === (couponCode?.trim().toUpperCase() ?? "");
        if (existingHold && (existingHold.bookingFingerprint === bookingFingerprint || legacyMatches) && existingHold.expiresAt && existingHold.expiresAt > now) {
          if (!await isVehicleAvailable(vehicleId, pickupAt, returnAt, { tx, excludeReservationId: existingHold.id })) return new HoldError("Vehicle no longer available", 409);
          if (params.draftId) await tx.bookingDraft.update({ where: { id: params.draftId }, data: { reservationId: existingHold.id } });
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

        if (extras.length !== new Set(extraIds).size) throw new HoldError("A selected extra is unavailable. Return to Extras and update your selection.", 400);
        let coupon = null;
        if (couponCode) {
          const found = await tx.coupon.findUnique({ where: { code: couponCode.trim().toUpperCase() } });
          const days = bookingDays(pickupAt, returnAt, bookingTimezone);
          if (found) {
            const validity = isCouponValid(found, { rentalDays: days, vehicleId });
            if (validity.valid) coupon = found;
          }
        }


        if (couponCode?.trim() && !coupon) throw new HoldError("Coupon is invalid or unavailable. Remove it or enter a valid code.", 400);
        const basePrice = calculatePricing({
          vehicle,
          pickupAt,
          returnAt,
          extras: extras.map((extra) => ({ extra, quantity: 1 })),
          coupon,
          taxRatePercent: vehicle.location === settings.address ? settings.taxRatePercent : 0, bookingTimezone,
        });

        const {breakdown,terms}=await financeQuote(tx,vehicle,basePrice,customerId);
        const expiresAt = new Date(now.getTime() + HOLD_DURATION_MINUTES * 60 * 1000);

        const reservation = await tx.reservation.create({
          data: {
            jurisdictionCode:jurisdiction.code,jurisdictionSnapshot:json(jurisdiction),
            bookingFingerprint,
            bookingTimezone,
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

        await tx.financeQuote.create({data:{reservationId:reservation.id,terms:json(terms)}});
        await tx.tripEvent.create({
          data: { reservationId: reservation.id, type: "CHECKOUT_HOLD_CREATED", actorId: customerId },
        });

        if (existingHold) await tx.driverDocument.updateMany({ where: { reservationId: existingHold.id, userId: customerId }, data: { reservationId: reservation.id } });
        if (params.draftId) await tx.bookingDraft.update({ where: { id: params.draftId }, data: { reservationId: reservation.id } });

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
