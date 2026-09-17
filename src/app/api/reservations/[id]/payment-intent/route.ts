import { createRentalPayment } from "@/lib/rental-payment";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { stripe, isStripeConfigured, isDevPaymentSimulationAllowed } from "@/lib/stripe";

/**
 * Creates (or reuses, for idempotency on refresh) the Stripe PaymentIntent
 * for a reservation's rental total. The security deposit — if the vehicle
 * requires one — is authorized separately via the same saved payment
 * method once this payment succeeds (see the Stripe webhook handler),
 * and the reservation only becomes CONFIRMED once *both* succeed (see
 * README "Payments" for the exact gating rule).
 *
 * When Stripe credentials are not configured, returns `devMode: true` so
 * the client can render a clearly-labeled development-only "simulate
 * payment" flow instead of a real card form.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id }, include: { payments: true } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  if (reservation.customerId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (reservation.status !== "AWAITING_PAYMENT") {
    return NextResponse.json({ error: "This reservation is not awaiting payment." }, { status: 409 });
  }
  if (reservation.expiresAt && reservation.expiresAt < new Date()) {
    return NextResponse.json({ error: "Your checkout window has expired. Please start again." }, { status: 409 });
  }

  if (!isStripeConfigured() || !stripe) {
    return NextResponse.json({ devMode: isDevPaymentSimulationAllowed(), totalCents: reservation.totalCents });
  }

  try {
    const intent = await createRentalPayment(id, session.user.id);
    return NextResponse.json({ clientSecret: intent.client_secret, devMode: false });
  } catch {
    return NextResponse.json({ error: "Payment initialization is pending. Retry this reservation." }, { status: 409 });
  }
}
