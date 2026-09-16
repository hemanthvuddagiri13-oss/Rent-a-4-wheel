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

export async function startRental(formData: FormData) {
  const session = await requireAdmin();
  const reservationId = String(formData.get("reservationId"));
  const mileage = Number(formData.get("mileage"));
  const fuelLevel = Number(formData.get("fuelLevel"));
  const notes = String(formData.get("notes") || "");

  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });

  // Staff "quick desk" override: skips the granular self-serve check-in/
  // trip-start gate (src/lib/trip-gate.ts) entirely. This is an audited
  // manual override path for in-person staff-assisted pickups, not the
  // ordinary customer/host self-serve flow.
  await prisma.$transaction(async (tx) => {
    await tx.vehicleInspection.create({
      data: {
        vehicleId: reservation.vehicleId,
        reservationId,
        type: "CHECK_OUT",
        mileage,
        fuelLevel,
        photoUrls: [],
        damageNotes: notes || null,
        performedById: session.user.id,
      },
    });
    await transitionReservation(tx, { id: reservationId, from: reservation.status, to: "ACTIVE", force: true });
    await tx.vehicle.update({ where: { id: reservation.vehicleId }, data: { mileage } });
    await tx.tripEvent.create({
      data: { reservationId, type: "TRIP_STARTED", actorId: session.user.id, metadata: { staffOverride: true } },
    });
  });

  await queueNotification({ userId: reservation.customerId, reservationId, type: "PICKUP_REMINDER" });
  revalidatePath(`/admin/reservations/${reservationId}`);
}

export async function completeRental(formData: FormData) {
  const session = await requireAdmin();
  const reservationId = String(formData.get("reservationId"));
  const mileage = Number(formData.get("mileage"));
  const fuelLevel = Number(formData.get("fuelLevel"));
  const notes = String(formData.get("notes") || "");
  const lateReturn = formData.get("lateReturn") === "on";
  const additionalChargeCents = Math.round(Number(formData.get("additionalCharge") || 0) * 100);

  const reservation = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: { vehicle: true },
  });
  const checkOut = await prisma.vehicleInspection.findFirst({
    where: { reservationId, type: "CHECK_OUT" },
    orderBy: { performedAt: "desc" },
  });
  const milesDriven = checkOut ? Math.max(0, mileage - checkOut.mileage) : 0;
  const allowance = reservation.vehicle.mileageAllowancePerDay * Math.max(1, reservation.units);
  const additionalMileage = Math.max(0, milesDriven - allowance);

  await prisma.$transaction(async (tx) => {
    await tx.vehicleInspection.create({
      data: {
        vehicleId: reservation.vehicleId,
        reservationId,
        type: "CHECK_IN",
        mileage,
        fuelLevel,
        photoUrls: [],
        damageNotes: notes || null,
        performedById: session.user.id,
        lateReturn,
        additionalMileage,
        additionalChargeCents,
      },
    });
    await transitionReservation(tx, { id: reservationId, from: reservation.status, to: "COMPLETED", force: true });
    await tx.vehicle.update({ where: { id: reservation.vehicleId }, data: { mileage } });
    await tx.tripEvent.create({
      data: { reservationId, type: "TRIP_COMPLETED", actorId: session.user.id, metadata: { staffOverride: true } },
    });
  });

  if (lateReturn && additionalChargeCents > 0) {
    await queueNotification({ userId: reservation.customerId, reservationId, type: "LATE_RETURN", extra: { additionalChargeCents } });
  }
  await queueNotification({ userId: reservation.customerId, reservationId, type: "RETURN_REMINDER" });
  revalidatePath(`/admin/reservations/${reservationId}`);
}
