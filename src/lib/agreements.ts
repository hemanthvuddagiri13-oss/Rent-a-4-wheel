import { withReservationLock } from "@/lib/financial-locks";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { storePrivateDocument } from "@/lib/storage";
import { generateRentalAgreementPdf } from "@/lib/agreement-pdf";
import type { LegalDocumentType, Prisma } from "@prisma/client";

export class AgreementNotReviewedError extends Error {
  constructor(type: LegalDocumentType) {
    super(
      `The ${type} document has not yet been reviewed by a licensed attorney and cannot be signed. An administrator must clear "needs attorney review" at /admin/legal before real bookings can proceed.`
    );
    this.name = "AgreementNotReviewedError";
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Records a versioned, immutable acceptance of a legal document. Freezes
 * the exact content and version shown at signing time into the acceptance
 * row itself (`contentSnapshot`/`contentHash`), so a later edit to the
 * editable `LegalDocument` row can never retroactively change what a
 * signer is deemed to have agreed to.
 *
 * Refuses to create an acceptance while the source document is still
 * flagged `needsAttorneyReview` — this is a hard compliance gate, not a
 * warning: real bookings/payments must not proceed against unreviewed
 * legal language (see README "Legal Content").
 */
export async function recordAgreementAcceptance(
  tx: Prisma.TransactionClient,
  params: {
    type: LegalDocumentType;
    reservationId?: string;
    vehicleId?: string;
    signedByUserId: string;
    signerName: string;
    ipAddress: string | null;
    userAgent: string | null;
  }
) {
  const legalDocument = await tx.legalDocument.findUnique({ where: { type: params.type } });
  if (!legalDocument) {
    throw new Error(`No LegalDocument configured for type ${params.type}.`);
  }
  if (legalDocument.needsAttorneyReview) {
    throw new AgreementNotReviewedError(params.type);
  }

  const contentHash = sha256Hex(legalDocument.content);
  const vehicle = params.vehicleId ? await tx.vehicle.findUnique({ where: { id: params.vehicleId } }) : null;
  const reservation = params.reservationId ? await tx.reservation.findUnique({ where: { id: params.reservationId }, include: { vehicle: true } }) : null;
  const subjectSnapshot = JSON.parse(JSON.stringify(reservation ? { reservation, vehicle: reservation.vehicle } : { vehicle })) as Prisma.InputJsonValue;

  const acceptance = await tx.agreementAcceptance.create({
    data: {
      type: params.type,
      documentVersion: legalDocument.version,
      contentHash,
      contentSnapshot: legalDocument.content,
      subjectSnapshot,
      reservationId: params.reservationId,
      vehicleId: params.vehicleId,
      signedByUserId: params.signedByUserId,
      signerName: params.signerName,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    },
  });

  return acceptance;
}

/**
 * Generates the immutable signed PDF snapshot for a RENTAL_AGREEMENT
 * acceptance and stores it in private storage, attaching the storage key
 * to the acceptance row. Separate from `recordAgreementAcceptance` because
 * it needs the full reservation/vehicle data and must run after the
 * acceptance transaction has committed (PDF generation is comparatively
 * slow and shouldn't hold the transaction open).
 */
export async function generateAndStoreSignedAgreementPdf(reservationId: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      vehicle: true,
      agreementAcceptances: { where: { type: "RENTAL_AGREEMENT" }, orderBy: { signedAt: "desc" }, take: 1 },
    },
  });
  if (!reservation) return;
  const acceptance = reservation.agreementAcceptances[0];
  if (!acceptance || acceptance.signedPdfStorageKey) return;

  const pdfBytes = await generateRentalAgreementPdf({ reservation, vehicle: reservation.vehicle, acceptance });
  const { storageKey } = await storePrivateDocument(Buffer.from(pdfBytes), "application/pdf");

  await withReservationLock(reservationId, tx => tx.agreementAcceptance.updateMany({
    where: { id: acceptance.id, signedPdfStorageKey: null },
    data: { signedPdfStorageKey: storageKey },
  }));
}
