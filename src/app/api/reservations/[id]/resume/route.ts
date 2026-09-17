import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pricingSummary } from "@/lib/reservation-summary";
import { withReservationLock } from "@/lib/financial-locks";
import { upgradeBookingFingerprint } from "@/lib/booking-fingerprint";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let r = await prisma.reservation.findUnique({ where: { id }, include: { extras: { include: { extra: { select: { name: true } } } }, coupon: true } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.customerId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try { await withReservationLock(id, tx => upgradeBookingFingerprint(tx, id)); }
  catch { return NextResponse.json({ error: "Legacy booking requires review before resuming" }, { status: 409 }); }
  r = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: { extras: { include: { extra: { select: { name: true } } } }, coupon: true } });
  const draft = await prisma.bookingDraft.findFirst({ where: { reservationId: id, customerId: session.user.id } });
  return NextResponse.json({ reservationId: id, vehicleId: r.vehicleId, confirmationNumber: r.confirmationNumber,
    bookingTimezone: r.bookingTimezone, pickupAt: r.pickupAt, returnAt: r.returnAt, selectedExtraIds: r.extras.map(e => e.extraId), couponCode: r.coupon?.code ?? "",
    checkoutComplete: Boolean(r.checkoutFingerprint), bookingFingerprint: r.bookingFingerprint, holdExpiresAt: r.expiresAt,
    breakdown: pricingSummary(r), draftId: draft?.id, revision: draft?.revision, status: r.status },
    { headers: { "Cache-Control": "private, no-store" } });
}
