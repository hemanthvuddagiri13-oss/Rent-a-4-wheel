import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isDevPaymentSimulationAllowed } from "@/lib/stripe";
import { queueNotification } from "@/lib/notifications";
import { transitionReservation } from "@/lib/reservation-state-machine";

/**
 * Development-only endpoint that simulates a successful payment, so the
 * full booking flow can be exercised end-to-end in local/dev environments
 * without real Stripe credentials. Requires an explicit local-dev opt-in
 * (`ALLOW_DEV_PAYMENT_SIMULATION=true`) AND `NODE_ENV === "development"`
 * AND the total absence of any Stripe configuration, even partial — see
 * `isDevPaymentSimulationAllowed()` in src/lib/stripe.ts. Refuses in
 * production, staging, and test, and refuses the instant any live Stripe
 * key/config is present anywhere. This route must never be reachable in a
 * real deployment.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDevPaymentSimulationAllowed()) {
    return NextResponse.json({ error: "Not available in this environment." }, { status: 403 });
  }

  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id }, include: { deposit: true } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  if (reservation.customerId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (reservation.status !== "AWAITING_PAYMENT") {
    return NextResponse.json({ error: "This reservation is not awaiting payment." }, { status: 409 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        reservationId: reservation.id,
        type: "RENTAL",
        status: "SUCCEEDED",
        amountCents: reservation.totalCents,
        idempotencyKey: `dev-${reservation.id}`,
      },
    });
    if (reservation.deposit) {
      await tx.securityDeposit.update({
        where: { id: reservation.deposit.id },
        data: { status: "SUCCEEDED" },
      });
    }
    await transitionReservation(tx, { id: reservation.id, from: "AWAITING_PAYMENT", to: "CONFIRMED" });
    await transitionReservation(tx, { id: reservation.id, from: "CONFIRMED", to: "DOCUMENTS_REQUIRED" });
    await tx.tripEvent.create({
      data: { reservationId: reservation.id, type: "PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED", metadata: { devSimulated: true } },
    });
  });

  await queueNotification({ userId: session.user.id, reservationId: reservation.id, type: "BOOKING_CONFIRMATION" });
  await queueNotification({
    userId: session.user.id,
    reservationId: reservation.id,
    type: "PAYMENT_RECEIPT",
    extra: { amountCents: reservation.totalCents, description: "Rental payment (development simulation)" },
  });

  return NextResponse.json({ success: true });
}
