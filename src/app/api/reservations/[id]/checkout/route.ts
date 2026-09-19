import { freezeFinance } from "@/lib/finance-rules";
import { safeLog } from "@/lib/safe-log";
import { withReservationLock } from "@/lib/financial-locks";
import { fingerprint } from "@/lib/financial-operations";
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
  const checkoutFingerprint = fingerprint(parsed.data);
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

  if (reservation.financialDisposition !== "OPEN" || !["CHECKOUT_HOLD", "AWAITING_PAYMENT"].includes(reservation.status) || !reservation.expiresAt || reservation.expiresAt <= new Date()) return NextResponse.json({ error: "Checkout unavailable" }, { status: 409 });
  if (reservation.checkoutFingerprint === checkoutFingerprint) return NextResponse.json({ success: true });
  if (reservation.bookingFingerprint && parsed.data.bookingFingerprint !== reservation.bookingFingerprint) return NextResponse.json({ error: "Booking changed; refresh your review." }, { status: 409 });
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
    await withReservationLock(id, async (tx) => {
      const current = await tx.reservation.findUniqueOrThrow({ where: { id } });
      if (current.financialDisposition !== "OPEN" || !["CHECKOUT_HOLD", "AWAITING_PAYMENT"].includes(current.status) || !current.expiresAt || current.expiresAt <= new Date()) throw new Error("Checkout unavailable");
      if (current.checkoutFingerprint === checkoutFingerprint) return;
      if (current.financialDisposition !== "OPEN" || current.status !== "CHECKOUT_HOLD" || !current.expiresAt || current.expiresAt <= new Date()) throw new Error("Checkout hold no longer valid");
      if (current.bookingFingerprint !== reservation.bookingFingerprint) throw new Error("Booking changed concurrently");
      if (!await isVehicleAvailable(current.vehicleId, current.pickupAt, current.returnAt, { tx, excludeReservationId: id })) throw new Error("Vehicle no longer available");
      const attached = await tx.driverDocument.updateMany({
        where: { id: { in: requestedDocIds }, userId: session.user.id, deletedAt: null, OR: [{ reservationId: null }, { reservationId: reservation.id }] },
        data: { reservationId: reservation.id },
      });

      if (attached.count !== requestedDocIds.length) throw new Error("Document ownership changed concurrently");

      await transitionReservation(tx, {
        id: reservation.id,
        from: "CHECKOUT_HOLD",
        to: "AWAITING_PAYMENT",
        data: {
          checkoutFingerprint,
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

      await freezeFinance(tx,id);
      // Freeze the finalized driver details, not the earlier empty checkout hold.
      // Legal rejection still rolls back this entire transaction.
      await recordAgreementAcceptance(tx, {
        type: "RENTAL_AGREEMENT",
        reservationId: reservation.id,
        signedByUserId: session.user.id,
        signerName: `${driver.firstName} ${driver.lastName}`,
        ipAddress: ip,
        userAgent,
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
    safeLog("CHECKOUT_FINALIZE_FAILED", err);
    return NextResponse.json({ error: "Something went wrong finishing checkout." }, { status: 409 });
  }

  // PDF generation is comparatively slow — run it after the transaction
  // commits rather than holding the transaction open for it.
  generateAndStoreSignedAgreementPdf(reservation.id).catch((err) =>
    safeLog("FAILED_TO_GENERATE_SIGNED_AGREEMENT_PDF", err)
  );

  return NextResponse.json({ success: true });
}
