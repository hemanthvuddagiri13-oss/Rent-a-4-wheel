import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { queueNotification } from "@/lib/notifications";
import { canCustomerCancel } from "@/lib/reservation-rules";
import { transitionReservation } from "@/lib/reservation-state-machine";

/**
 * Customer-initiated cancellation request. This marks the reservation
 * CANCELLED_BY_CUSTOMER immediately for reservations that haven't started
 * yet; actual refund issuance (full/partial, per the Cancellation Policy)
 * is handled by staff from /admin/reservations, since it may depend on
 * manual policy judgment calls the schema doesn't automate.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (reservation.customerId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const eligibility = canCustomerCancel(reservation);
  if (!eligibility.allowed) {
    return NextResponse.json({ error: eligibility.reason }, { status: 409 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await transitionReservation(tx, {
        id,
        from: reservation.status,
        to: "CANCELLED_BY_CUSTOMER",
        data: { expiresAt: null },
      });
      await tx.auditLog.create({
        data: {
          actorId: session.user.id,
          action: "reservation.cancel",
          entityType: "Reservation",
          entityId: id,
          metadata: { initiatedBy: "customer" },
        },
      });
      await tx.tripEvent.create({
        data: { reservationId: id, type: "CANCELLED_BY_CUSTOMER", actorId: session.user.id },
      });
    });
  } catch {
    return NextResponse.json({ error: "This reservation was already updated. Please refresh and try again." }, { status: 409 });
  }

  await queueNotification({ userId: session.user.id, reservationId: id, type: "CANCELLATION" });

  return NextResponse.json({ success: true });
}
