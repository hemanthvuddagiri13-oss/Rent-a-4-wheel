"use server";

import { canAccessAdmin } from "@/lib/rbac";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";
import { transitionReservation } from "@/lib/reservation-state-machine";

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

export async function issueRefund(reservationId: string, amountCents: number, reason?: string) {
  const session = await requireAdmin();
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { payments: { where: { type: "RENTAL", status: "SUCCEEDED" } } },
  });
  if (!reservation) throw new Error("Reservation not found.");
  const payment = reservation.payments[0];
  if (!payment) throw new Error("No successful payment found to refund.");

  let stripeRefundId: string | undefined;
  if (stripe && payment.stripePaymentIntentId) {
    const refund = await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId, amount: amountCents });
    stripeRefundId = refund.id;
  }

  await prisma.refund.create({
    data: {
      reservationId,
      paymentId: payment.id,
      amountCents,
      reason,
      status: "SUCCEEDED",
      stripeRefundId,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "reservation.refund", entityType: "Reservation", entityId: reservationId, metadata: { amountCents } },
  });

  await queueNotification({ userId: reservation.customerId, reservationId, type: "REFUND", extra: { amountCents } });
  revalidatePath(`/admin/reservations/${reservationId}`);
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
