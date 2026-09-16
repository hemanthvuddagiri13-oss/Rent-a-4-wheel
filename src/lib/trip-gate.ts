import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getSiteSettings } from "@/lib/settings";

export interface TripStartGateResult {
  canStart: boolean;
  reasons: string[]; // human-readable unmet conditions, empty when canStart is true
}

const REQUIRED_DOCUMENT_TYPES = ["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"] as const;

/**
 * Evaluates every precondition required before "Start Trip" is allowed
 * (see README "Trip-Start Rule"). This is the single source of truth for
 * that gate — both the API route that actually starts the trip and any
 * UI that wants to show a checklist call this same function, so the rule
 * can never drift between what's displayed and what's enforced.
 */
export async function evaluateTripStartGate(reservationId: string, db: Prisma.TransactionClient = prisma): Promise<TripStartGateResult> {
  const reasons: string[] = [];

  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    include: {
      payments: true,
      deposit: true,
      refunds: true,
      documents: { where: { deletedAt: null } },
      agreementAcceptances: { where: { type: "RENTAL_AGREEMENT" } },
      identityHandoff: true,
      conditionReports: { where: { phase: "PRE_TRIP" } },
    },
  });

  if (!reservation) {
    return { canStart: false, reasons: ["Reservation not found."] };
  }

  // Reservation must be confirmed (i.e. have progressed past AWAITING_PAYMENT)
  // and not already active/terminal.
  const preTripStatuses = ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"];
  if (!preTripStatuses.includes(reservation.status)) {
    reasons.push(`Reservation status (${reservation.status}) is not eligible to start a trip.`);
  }

  const rentalPaid = reservation.payments.some((p) => p.type === "RENTAL" && p.status === "SUCCEEDED");
  if (reservation.financialDisposition !== "OPEN") reasons.push("Reservation has a terminal or unresolved financial disposition.");
  if (!rentalPaid) reasons.push("Rental payment has not succeeded.");

  // A reservation refunded back to zero (or below) net paid must never
  // start a trip, even if a RENTAL payment once succeeded — the money the
  // trip is predicated on is no longer actually held.
  const paidCents = reservation.payments
    .filter((p) => p.type === "RENTAL" && p.status === "SUCCEEDED")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const refundedCents = reservation.refunds
    .filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
    .reduce((sum, r) => sum + r.amountCents, 0);
  if (rentalPaid && paidCents - refundedCents <= 0) {
    reasons.push("Rental payment has been fully refunded; this reservation cannot start a trip.");
  }

  if (reservation.depositCents > 0 && !reservation.deposit) reasons.push("Required security deposit record is missing.");
  if (reservation.deposit) {
    const authValid = reservation.deposit.authorizationExpiresAt && reservation.deposit.authorizationExpiresAt > new Date();
    if (reservation.deposit.status !== "SUCCEEDED" || reservation.deposit.stripeStatus !== "requires_capture" || reservation.deposit.amountCents !== reservation.depositCents || !authValid) {
      reasons.push("Security deposit does not have a currently valid authorization.");
    }
  }

  for (const type of REQUIRED_DOCUMENT_TYPES) {
    if (!reservation.documents.some((d) => d.type === type)) {
      reasons.push(`Missing required document: ${type}.`);
    }
  }

  if (reservation.agreementAcceptances.length === 0) {
    reasons.push("Rental agreement has not been signed.");
  }

  const handoff = reservation.identityHandoff;
  if (
    !handoff ||
    !handoff.verifiedAt ||
    !handoff.licenseMatchesUpload ||
    !handoff.physicalLicenseUnexpired ||
    !handoff.selfieMatchesCustomer
  ) {
    reasons.push("Host has not completed identity handoff verification.");
  }

  const hostPreTrip = reservation.conditionReports.find((r) => r.submittedByRole === "HOST");
  const customerPreTrip = reservation.conditionReports.find((r) => r.submittedByRole === "CUSTOMER");
  if (!hostPreTrip) reasons.push("Host has not submitted a pre-trip condition report.");
  if (!customerPreTrip) reasons.push("Customer has not submitted a pre-trip condition report.");
  if (hostPreTrip && !hostPreTrip.acceptedAt) reasons.push("Host has not accepted the pre-trip condition report.");
  if (customerPreTrip && !customerPreTrip.acceptedAt) reasons.push("Customer has not accepted the pre-trip condition report.");

  if (hostPreTrip) {
    const photoCount = await db.conditionPhoto.count({ where: { conditionReportId: hostPreTrip.id } });
    if (photoCount === 0) reasons.push("Host has not uploaded pre-trip photos.");
  }
  if (customerPreTrip) {
    const photoCount = await db.conditionPhoto.count({ where: { conditionReportId: customerPreTrip.id } });
    if (photoCount === 0) reasons.push("Customer has not uploaded pre-trip photos.");
  }

  const settings = await getSiteSettings();
  const windowStart = new Date(reservation.pickupAt.getTime() - settings.checkInWindowHours * 60 * 60 * 1000);
  const now = new Date();
  if (now < windowStart) {
    reasons.push(`Pickup time is outside the permitted check-in window (opens ${windowStart.toISOString()}).`);
  }

  return { canStart: reasons.length === 0, reasons };
}
