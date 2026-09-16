"use server";

import { canAccessAdmin } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { queueNotification } from "@/lib/notifications";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { getOrCreateRefundOperation, executeRefundOperation } from "@/lib/refund-operations";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) {
    throw new Error("Forbidden");
  }
  return session;
}

export async function updateDocumentStatus(documentId: string, status: "APPROVED" | "REJECTED" | "NEEDS_INFORMATION") {
  const session = await requireAdmin();
  const doc = await prisma.driverDocument.update({
    where: { id: documentId },
    data: { status, reviewedById: session.user.id, reviewedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "document.review", entityType: "DriverDocument", entityId: documentId, metadata: { status } },
  });

  // If all of a customer's documents for a reservation are approved, mark
  // their overall verification status approved too.
  if (doc.reservationId) {
    const docs = await prisma.driverDocument.findMany({ where: { reservationId: doc.reservationId } });
    if (docs.length > 0 && docs.every((d) => d.status === "APPROVED")) {
      const reservation = await prisma.reservation.findUnique({ where: { id: doc.reservationId } });
      if (reservation) {
        await prisma.customer.updateMany({
          where: { userId: reservation.customerId },
          data: { verificationStatus: "APPROVED" },
        });
      }
    }
    revalidatePath(`/admin/reservations/${doc.reservationId}`);
  }
}

export async function cancelReservation(reservationId: string, notes?: string) {
  const session = await requireAdmin();
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });

  await prisma.$transaction(async (tx) => {
    await transitionReservation(tx, {
      id: reservationId,
      from: reservation.status,
      to: "CANCELLED_BY_HOST",
      force: true, // staff can cancel from any pre-trip status, not just the ordinary customer-facing set
      data: { notes, expiresAt: null },
    });
    await tx.tripEvent.create({ data: { reservationId, type: "CANCELLED_BY_HOST", actorId: session.user.id } });
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "reservation.cancel", entityType: "Reservation", entityId: reservationId, metadata: { initiatedBy: "staff" } },
  });
  await queueNotification({ userId: reservation.customerId, reservationId, type: "CANCELLATION" });
  revalidatePath(`/admin/reservations/${reservationId}`);
  revalidatePath("/admin/reservations");
}

/**
 * Staff-initiated refund. `requestId` must be a client-generated token
 * that is stable across retries of the SAME submission (so a network
 * retry or a double-click while the button is still disabled resumes the
 * same durable Refund row instead of calling Stripe a second time) but
 * fresh for each genuinely new refund a staff member issues. Amount is
 * validated against the reservation's actual remaining refundable
 * balance — never trusted as-is from the client.
 */
export async function issueRefund(reservationId: string, amountCents: number, requestId: string, reason?: string) {
  const session = await requireAdmin();
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Refund amount must be a positive number.");
  }
  if (!requestId) {
    throw new Error("Missing request id.");
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      payments: { where: { type: "RENTAL", status: "SUCCEEDED" } },
      refunds: true,
    },
  });
  if (!reservation) throw new Error("Reservation not found.");
  const payment = reservation.payments[0];
  if (!payment) throw new Error("No successful payment found to refund.");

  // Exclude this exact requestId's own prior attempt (if any) from the
  // "already refunded" total — resuming an idempotent retry must never
  // be rejected as exceeding the balance against itself.
  const idempotencyKey = `staff-${requestId}`;
  const alreadyRefundedCents = reservation.refunds
    .filter((r) => r.idempotencyKey !== idempotencyKey && (r.status === "SUCCEEDED" || r.status === "PENDING"))
    .reduce((sum, r) => sum + r.amountCents, 0);
  const remainingCents = payment.amountCents - alreadyRefundedCents;
  if (amountCents > remainingCents) {
    throw new Error(`Refund amount exceeds the remaining refundable balance ($${(remainingCents / 100).toFixed(2)}).`);
  }

  const refund = await getOrCreateRefundOperation({
    idempotencyKey,
    reservationId,
    paymentId: payment.id,
    amountCents,
    reason,
    initiatedById: session.user.id,
  });
  const result = await executeRefundOperation(refund.id, payment.stripePaymentIntentId);
  if (result.status === "FAILED" || result.status === "CANCELLED" || (result.status === "already_terminal" && ["FAILED", "CANCELLED"].includes(result.refund.status))) return { status: "failed" };

  revalidatePath(`/admin/reservations/${reservationId}`);
  return { status: result.status === "SUCCEEDED" || (result.status === "already_terminal" && result.refund.status === "SUCCEEDED") ? "succeeded" : "pending" };
}

// NOTE: the ordinary "quick start rental" / "quick complete rental" staff
// shortcuts that used to live here (bypassing src/lib/trip-gate.ts via a
// bare admin-role check, with no step-up verification, no mandatory
// reason, and no confirmation step) have been removed following security
// review — an ordinary ADMIN/STAFF session must never be able to force a
// reservation into ACTIVE/COMPLETED on its own. The only remaining path
// to force a reservation past an unmet gate is the dedicated,
// SUPER_ADMIN-only, step-up-verified, reason-required, confirmed, and
// fully audited emergency override — see src/lib/emergency-override.ts
// and POST /api/admin/reservations/[id]/emergency-override. It is
// intentionally not linked from this ordinary admin UI.
