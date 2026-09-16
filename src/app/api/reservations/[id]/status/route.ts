import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * Lightweight polling endpoint used by the checkout UI (see
 * step-payment.tsx) after a client-side `stripe.confirmPayment()` call
 * resolves. Confirming client-side only proves the PaymentIntent reached
 * a confirmable state — it does NOT prove the webhook has finished
 * persisting the rental payment, authorizing the security deposit, and
 * transitioning the reservation. The UI polls this route and must keep
 * showing "Processing" until it reports a terminal outcome; it must
 * never claim "Confirmed" on the strength of the client-side call alone.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { payments: true, deposit: true },
  });
  if (!reservation) return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  if (reservation.customerId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rentalPayment = reservation.payments.find((p) => p.type === "RENTAL");

  let outcome: "processing" | "confirmed" | "payment_failed" | "refunded" | "expired" | "cancelled";
  if (["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START", "ACTIVE"].includes(reservation.status)) {
    outcome = "confirmed";
  } else if (reservation.status === "PAYMENT_FAILED") {
    outcome = "payment_failed";
  } else if (reservation.status === "EXPIRED") {
    outcome = rentalPayment?.status === "SUCCEEDED" ? "refunded" : "expired";
  } else if (reservation.status === "CANCELLED_BY_CUSTOMER" || reservation.status === "CANCELLED_BY_HOST") {
    outcome = "cancelled";
  } else {
    outcome = "processing";
  }

  return NextResponse.json({
    status: reservation.status,
    outcome,
    rentalPaymentStatus: rentalPayment?.status ?? null,
    depositStatus: reservation.deposit?.status ?? null,
  });
}
