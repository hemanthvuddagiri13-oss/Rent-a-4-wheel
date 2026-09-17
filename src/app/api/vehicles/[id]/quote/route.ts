import { bookingInstant, bookingDays } from "@/lib/booking-time";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { calculatePricing, isCouponValid } from "@/lib/pricing";
import { isVehicleAvailable } from "@/lib/availability";
import { getSiteSettings } from "@/lib/settings";
import { quoteRequestSchema } from "@/lib/validations/quote";

/**
 * Server-authoritative price quote. The client never computes totals —
 * it only renders whatever this endpoint returns. Called both from the
 * vehicle detail page (live preview) and each step of the booking flow.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = quoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const vehicle = await prisma.vehicle.findUnique({ where: { id } });
  if (!vehicle) return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });

  const settings = await getSiteSettings();
  let pickupAt: Date, returnAt: Date;
  try { pickupAt = bookingInstant(parsed.data.pickupAt, settings.bookingTimezone); returnAt = bookingInstant(parsed.data.returnAt, settings.bookingTimezone); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }

  if (returnAt <= pickupAt) return NextResponse.json({ error: "Return date must be after pickup date" }, { status: 400 });
  const available = await isVehicleAvailable(vehicle.id, pickupAt, returnAt);
  if (!available) {
    return NextResponse.json({ error: "This vehicle is not available for the selected dates." }, { status: 409 });
  }

  const extras = parsed.data.extraIds.length
    ? await prisma.extra.findMany({ where: { id: { in: parsed.data.extraIds }, isActive: true } })
    : [];

  if (extras.length !== new Set(parsed.data.extraIds).size) return NextResponse.json({ error: "A selected extra is unavailable" }, { status: 400 });
  let coupon = null;
  let couponError: string | undefined;
  if (parsed.data.couponCode) {
    const found = await prisma.coupon.findUnique({ where: { code: parsed.data.couponCode.toUpperCase() } });
    if (!found) {
      couponError = "Coupon code not found.";
    } else {
      const days = bookingDays(pickupAt, returnAt, settings.bookingTimezone);
      const validity = isCouponValid(found, { rentalDays: days, vehicleId: vehicle.id });
      if (!validity.valid) couponError = validity.reason;
      else coupon = found;
    }
  }

  if (couponError) return NextResponse.json({ error: couponError }, { status: 400 });

  const breakdown = calculatePricing({
    vehicle,
    pickupAt,
    returnAt,
    extras: extras.map((extra) => ({ extra, quantity: 1 })),
    coupon,
    taxRatePercent: settings.taxRatePercent, bookingTimezone: settings.bookingTimezone,
  });

  return NextResponse.json({ breakdown, couponError, couponApplied: Boolean(coupon) });
}
