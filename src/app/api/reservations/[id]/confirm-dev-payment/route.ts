import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isStripeConfigured } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";

/**
 * Development-only endpoint that simulates a successful payment when no
 * Stripe credentials are configured, so the full booking flow can be
 * exercised end-to-end in local/dev environments. This route refuses to
 * run once real Stripe keys are present — production payments always go
 * through the real PaymentIntent + webhook flow.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isStripeConfigured()) {
    return NextResponse.json({ error: "Not available once Stripe is configured." }, { status: 403 });
  }

  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  if (reservation.customerId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (reservation.status !== "PENDING") {
    return NextResponse.json({ error: "This reservation has already been processed." }, { status: 409 });
  }

  await prisma.$transaction([
    prisma.payment.create({
      data: {
        reservationId: reservation.id,
        type: "RENTAL",
        status: "SUCCEEDED",
        amountCents: reservation.totalCents,
        idempotencyKey: `dev-${reservation.id}`,
      },
    }),
    prisma.reservation.update({ where: { id: reservation.id }, data: { status: "CONFIRMED" } }),
  ]);

  await queueNotification({ userId: session.user.id, reservationId: reservation.id, type: "BOOKING_CONFIRMATION" });
  await queueNotification({
    userId: session.user.id,
    reservationId: reservation.id,
    type: "PAYMENT_RECEIPT",
    extra: { amountCents: reservation.totalCents, description: "Rental payment (development simulation)" },
  });

  return NextResponse.json({ success: true });
}
