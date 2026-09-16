import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isVehicleAvailable } from "@/lib/availability";
import { checkoutSchema } from "@/lib/validations/reservation";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { recordAgreementAcceptance, AgreementNotReviewedError } from "@/lib/agreements";
import { generateAndStoreSignedAgreementPdf } from "@/lib/agreements";
import { getRequestIp } from "@/lib/auth-code";
import { verifyDocumentOwnership } from "@/lib/documents";

const CHECKOUT_WINDOW_MINUTES = 15;

/**
 * Finalizes a checkout hold into a payment-ready reservation: attaches
 * driver info and identity documents (ownership-checked — a document can
 * never be attached to a reservation its uploader doesn't own), records
 * the rental-agreement acceptance, and transitions CHECKOUT_HOLD ->
 * AWAITING_PAYMENT. Refuses if the hold has expired or already moved on.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { driver, documentIds, agreementAccepted } = parsed.data;
  if (!agreementAccepted) {
    return NextResponse.json({ error: "You must accept the Rental Agreement to continue." }, { status: 400 });
  }
  if (!documentIds.front || !documentIds.back || !documentIds.selfie) {
    return NextResponse.json(
      { error: "License front, license back, and a selfie holding your license are all required." },
      { status: 400 }
    );
  }

  const reservation = await prisma.reservation.findUnique({ where: { id }, include: { documents: { where: { deletedAt: null } } } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  if (reservation.customerId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Idempotent retry: this exact checkout already succeeded (e.g. the
  // client's own retry after a dropped response, or the payment step
  // remounting and re-finalizing before starting the PaymentIntent) — the
  // reservation has already moved on to AWAITING_PAYMENT with these same
  // documents and driver details attached. Resume rather than returning
  // an unrecoverable 409 (item 13); a request with genuinely DIFFERENT
  // inputs than what was already finalized is still rejected below.
  if (reservation.status === "AWAITING_PAYMENT") {
    const docTypesById = Object.fromEntries(reservation.documents.map((d) => [d.id, d.type]));
    const sameDocuments =
      docTypesById[documentIds.front] === "LICENSE_FRONT" &&
      docTypesById[documentIds.back] === "LICENSE_BACK" &&
      docTypesById[documentIds.selfie] === "SELFIE_WITH_LICENSE";
    const sameDriver = reservation.driverEmail === driver.email && reservation.licenseNumber === driver.licenseNumber;
    if (sameDocuments && sameDriver) {
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: "This reservation is no longer awaiting checkout." }, { status: 409 });
  }

  if (reservation.status !== "CHECKOUT_HOLD") {
    return NextResponse.json({ error: "This reservation is no longer awaiting checkout." }, { status: 409 });
  }
  if (!reservation.expiresAt || reservation.expiresAt < new Date()) {
    return NextResponse.json({ error: "Your hold on this vehicle has expired. Please start again." }, { status: 409 });
  }

  const stillAvailable = await isVehicleAvailable(reservation.vehicleId, reservation.pickupAt, reservation.returnAt, {
    excludeReservationId: reservation.id,
  });
  if (!stillAvailable) {
    return NextResponse.json({ error: "This vehicle is no longer available for the selected dates." }, { status: 409 });
  }

  // Ownership check: a document can only be attached if it belongs to this
  // user and either isn't attached to any reservation yet, or is already
  // attached to this exact one (idempotent retry) — never to a reservation
  // its uploader doesn't own.
  const requestedDocIds = [documentIds.front, documentIds.back, documentIds.selfie];
  const ownershipOk = await verifyDocumentOwnership({
    documentIds: requestedDocIds,
    userId: session.user.id,
    reservationId: reservation.id,
  });
  if (!ownershipOk) {
    return NextResponse.json({ error: "One or more uploaded documents could not be verified." }, { status: 403 });
  }
  const ownedDocs = await prisma.driverDocument.findMany({ where: { id: { in: requestedDocIds } } });
  const docByType = Object.fromEntries(ownedDocs.map((d) => [d.id, d.type]));
  if (
    docByType[documentIds.front] !== "LICENSE_FRONT" ||
    docByType[documentIds.back] !== "LICENSE_BACK" ||
    docByType[documentIds.selfie] !== "SELFIE_WITH_LICENSE"
  ) {
    return NextResponse.json({ error: "Documents were uploaded for the wrong document type." }, { status: 400 });
  }

  const ip = getRequestIp(req.headers);
  const userAgent = req.headers.get("user-agent");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.driverDocument.updateMany({
        where: { id: { in: requestedDocIds }, userId: session.user.id },
        data: { reservationId: reservation.id },
      });

      await recordAgreementAcceptance(tx, {
        type: "RENTAL_AGREEMENT",
        reservationId: reservation.id,
        signedByUserId: session.user.id,
        signerName: `${driver.firstName} ${driver.lastName}`,
        ipAddress: ip,
        userAgent,
      });

      await transitionReservation(tx, {
        id: reservation.id,
        from: "CHECKOUT_HOLD",
        to: "AWAITING_PAYMENT",
        data: {
          expiresAt: new Date(Date.now() + CHECKOUT_WINDOW_MINUTES * 60 * 1000),
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
        },
      });

      await tx.tripEvent.create({
        data: { reservationId: reservation.id, type: "CHECKOUT_COMPLETED", actorId: session.user.id },
      });
    });
  } catch (err) {
    if (err instanceof AgreementNotReviewedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "23P01") {
      return NextResponse.json({ error: "This vehicle is no longer available for the selected dates." }, { status: 409 });
    }
    console.error("Checkout finalize failed", err);
    return NextResponse.json({ error: "Something went wrong finishing checkout." }, { status: 500 });
  }

  // PDF generation is comparatively slow — run it after the transaction
  // commits rather than holding the transaction open for it.
  generateAndStoreSignedAgreementPdf(reservation.id).catch((err) =>
    console.error("Failed to generate signed agreement PDF", err)
  );

  return NextResponse.json({ success: true });
}
