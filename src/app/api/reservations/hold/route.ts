import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isVehicleAvailable } from "@/lib/availability";
import { calculatePricing, isCouponValid } from "@/lib/pricing";
import { getSiteSettings } from "@/lib/settings";
import { generateConfirmationNumber } from "@/lib/confirmation";
import { createHoldSchema } from "@/lib/validations/reservation";

const HOLD_DURATION_MINUTES = 15;

/**
 * Places a 15-minute checkout hold on a vehicle for a specific date/time
 * range. This is the very first server-side write in the booking flow —
 * it exists so a customer who has just authenticated (holds require
 * sign-in; see README "Checkout Holds" for the reasoning) can safely spend
 * a few minutes on driver info, document uploads, and payment without
 * another customer grabbing the same dates out from under them.
 *
 * Re-checks availability inside a SERIALIZABLE transaction (never trusts
 * client-submitted availability) and is idempotent per (customer, vehicle,
 * dates): calling it again while a live hold already exists for the same
 * customer/vehicle/dates just refreshes that hold's expiry instead of
 * creating a duplicate row (e.g. the wizard re-mounting, or a page reload).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "You must be signed in to hold a vehicle." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createHoldSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { vehicleId, extraIds, couponCode } = parsed.data;
  const pickupAt = new Date(parsed.data.pickupAt);
  const returnAt = new Date(parsed.data.returnAt);
  if (returnAt <= pickupAt) {
    return NextResponse.json({ error: "Return date must be after pickup date." }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const existingHold = await tx.reservation.findFirst({
          where: {
            customerId: session.user.id,
            vehicleId,
            pickupAt,
            returnAt,
            status: "CHECKOUT_HOLD",
          },
        });

        const expiresAt = new Date(Date.now() + HOLD_DURATION_MINUTES * 60 * 1000);

        if (existingHold) {
          const refreshed = await tx.reservation.update({
            where: { id: existingHold.id },
            data: { expiresAt },
          });
          return refreshed;
        }

        const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle || vehicle.status !== "ACTIVE") {
          throw new BookingError("This vehicle is not currently available.", 404);
        }

        const available = await isVehicleAvailable(vehicleId, pickupAt, returnAt, { tx });
        if (!available) {
          throw new BookingError("This vehicle is no longer available for the selected dates.", 409);
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

        const reservation = await tx.reservation.create({
          data: {
            confirmationNumber: generateConfirmationNumber(),
            customerId: session.user.id,
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
          data: { reservationId: reservation.id, type: "CHECKOUT_HOLD_CREATED", actorId: session.user.id },
        });

        return reservation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return NextResponse.json({
      id: result.id,
      confirmationNumber: result.confirmationNumber,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2034" || err.code === "23P01")) {
      return NextResponse.json(
        { error: "Another booking is being processed for this vehicle. Please try again." },
        { status: 409 }
      );
    }
    console.error("Checkout hold creation failed", err);
    return NextResponse.json({ error: "Something went wrong holding this vehicle." }, { status: 500 });
  }
}

class BookingError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
