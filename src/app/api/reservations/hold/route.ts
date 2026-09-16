import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { createOrRefreshHold, HoldError } from "@/lib/checkout-hold";
import { createHoldSchema } from "@/lib/validations/reservation";

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
    const result = await createOrRefreshHold({
      customerId: session.user.id,
      vehicleId,
      pickupAt: new Date(parsed.data.pickupAt),
      returnAt: new Date(parsed.data.returnAt),
      extraIds,
      couponCode,
    });
    return NextResponse.json({ id: result.id, confirmationNumber: result.confirmationNumber, expiresAt: result.expiresAt });
  } catch (err) {
    if (err instanceof HoldError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("Checkout hold creation failed", err);
    return NextResponse.json({ error: "Something went wrong holding this vehicle." }, { status: 500 });
  }
}
