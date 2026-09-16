import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isVehicleAvailable } from "@/lib/availability";
import { calculatePricing, isCouponValid } from "@/lib/pricing";
import { getSiteSettings } from "@/lib/settings";
import { generateConfirmationNumber } from "@/lib/confirmation";
import { createReservationSchema } from "@/lib/validations/reservation";
import { queueNotification } from "@/lib/notifications";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservations = await prisma.reservation.findMany({
    where: { customerId: session.user.id },
    include: { vehicle: { include: { images: { take: 1, orderBy: { position: "asc" } } } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ reservations });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "You must be signed in to book a reservation." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createReservationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { vehicleId, extraIds, couponCode, driver, documentIds, agreementAccepted } = parsed.data;
  const pickupAt = new Date(parsed.data.pickupAt);
  const returnAt = new Date(parsed.data.returnAt);

  if (!agreementAccepted) {
    return NextResponse.json({ error: "You must accept the Rental Agreement to continue." }, { status: 400 });
  }
  if (returnAt <= pickupAt) {
    return NextResponse.json({ error: "Return date must be after pickup date." }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
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

        const legalAgreement = await tx.legalDocument.findUnique({ where: { type: "RENTAL_AGREEMENT" } });

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
            status: "PENDING",
            driverFirstName: driver.firstName,
            driverLastName: driver.lastName,
            driverDob: new Date(driver.dob),
            driverEmail: driver.email,
            driverPhone: driver.phone,
            driverAddress: driver.address,
            driverCity: driver.city,
            driverState: driver.state,
            driverZip: driver.zip,
            driverCountry: driver.country,
            licenseNumber: driver.licenseNumber,
            licenseState: driver.licenseState,
            licenseExpiration: new Date(driver.licenseExpiration),
            agreementAcceptedAt: new Date(),
            agreementVersionAccepted: legalAgreement?.version ?? "v1-draft",
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
            ...(legalAgreement
              ? {
                  agreement: {
                    create: {
                      documentVersion: legalAgreement.version,
                      acceptedAt: new Date(),
                      signerName: `${driver.firstName} ${driver.lastName}`,
                    },
                  },
                }
              : {}),
          },
        });

        if (coupon) {
          await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
        }

        if (documentIds.front) {
          await tx.driverDocument.updateMany({
            where: { id: documentIds.front, userId: session.user.id },
            data: { reservationId: reservation.id },
          });
        }
        if (documentIds.back) {
          await tx.driverDocument.updateMany({
            where: { id: documentIds.back, userId: session.user.id },
            data: { reservationId: reservation.id },
          });
        }

        await tx.auditLog.create({
          data: {
            actorId: session.user.id,
            action: "reservation.create",
            entityType: "Reservation",
            entityId: reservation.id,
            metadata: { vehicleId, totalCents: breakdown.totalCents },
          },
        });

        return reservation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    await queueNotification({
      userId: session.user.id,
      reservationId: result.id,
      type: "BOOKING_CONFIRMATION",
    });

    return NextResponse.json({ id: result.id, confirmationNumber: result.confirmationNumber });
  } catch (err) {
    if (err instanceof BookingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
      return NextResponse.json(
        { error: "Another booking is being processed for this vehicle. Please try again." },
        { status: 409 }
      );
    }
    console.error("Reservation creation failed", err);
    return NextResponse.json({ error: "Something went wrong creating your reservation." }, { status: 500 });
  }
}

class BookingError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
