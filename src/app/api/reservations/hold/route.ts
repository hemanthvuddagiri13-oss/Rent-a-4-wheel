import { bookingInstant } from "@/lib/booking-time";
import { getSiteSettings } from "@/lib/settings";
import { safeLog } from "@/lib/safe-log";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { createOrRefreshHold, HoldError } from "@/lib/checkout-hold";
import { createHoldSchema } from "@/lib/validations/reservation";
import { prisma } from "@/lib/prisma";
import { bookingDays } from "@/lib/booking-time";

/**
 * Places a 15-minute checkout hold on a vehicle for a specific date/time
 * range. This is the very first server-side write in the booking flow —
 * it exists so a customer who has just authenticated (holds require
 * sign-in; see README "Checkout Holds" for the reasoning) can safely spend
 * a few minutes on driver info, document uploads, and payment without
 * another customer grabbing the same dates out from under them.
 *
 * See src/lib/checkout-hold.ts for the actual logic (re-validates
 * availability inside a SERIALIZABLE transaction, and correctly refuses
 * to hand back dates on an expired hold if someone else already took
 * them — never trusts client-submitted availability).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "You must be signed in to hold a vehicle." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createHoldSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { vehicleId, extraIds, couponCode } = parsed.data;

  try {
    const draft = await prisma.bookingDraft.findUnique({ where: { id: parsed.data.draftId } });
    const prior = draft?.customerId === session.user.id && draft.reservationId ? await prisma.reservation.findUnique({ where: { id: draft.reservationId } }) : null;
    const bookingTimezone = prior?.bookingTimezone ?? (await getSiteSettings()).bookingTimezone;
    let pickupAt: Date, returnAt: Date;
    try { pickupAt = bookingInstant(parsed.data.pickupAt, bookingTimezone); returnAt = bookingInstant(parsed.data.returnAt, bookingTimezone); }
    catch (error) { throw new HoldError((error as Error).message, 400); }
    const result = await createOrRefreshHold({
      customerId: session.user.id,
      draftId: parsed.data.draftId,
      revision: parsed.data.revision,
      vehicleId,
      pickupAt, bookingTimezone,
      returnAt,
      extraIds,
      couponCode,
    });
    const extras = await prisma.reservationExtra.findMany({ where: { reservationId: result.id }, include: { extra: { select: { name: true } } } });
    const breakdown = { rateType: result.rateType, rateAmountCents: result.rateAmountCents, units: result.units,
      days: bookingDays(result.pickupAt, result.returnAt, result.bookingTimezone), subtotalCents: result.subtotalCents,
      extrasCents: result.extrasCents, discountCents: result.discountCents, taxCents: result.taxCents, feesCents: result.feesCents,
      totalCents: result.totalCents, depositCents: result.depositCents,
      extraLineItems: extras.map(e => ({ extraId: e.extraId, name: e.extra.name, amountCents: e.amountCents, quantity: e.quantity })) };
    return NextResponse.json({ id: result.id, bookingTimezone: result.bookingTimezone, pickupAt: result.pickupAt, returnAt: result.returnAt, confirmationNumber: result.confirmationNumber, expiresAt: result.expiresAt, bookingFingerprint: result.bookingFingerprint, totalCents: result.totalCents, breakdown });
  } catch (err) {
    if (err instanceof HoldError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    safeLog("CHECKOUT_HOLD_CREATION_FAILED", err);
    return NextResponse.json({ error: "Something went wrong holding this vehicle." }, { status: 500 });
  }
}
