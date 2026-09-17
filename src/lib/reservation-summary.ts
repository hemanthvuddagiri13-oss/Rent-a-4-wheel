import { bookingDays } from "@/lib/booking-time";
import type { Reservation } from "@prisma/client";
export function pricingSummary(r: Reservation & { extras?: Array<{ extraId: string; quantity: number; amountCents: number; extra?: { name: string } }> }) {
  return { rateType: r.rateType, rateAmountCents: r.rateAmountCents, units: r.units,
    days: bookingDays(r.pickupAt, r.returnAt, r.bookingTimezone),
    subtotalCents: r.subtotalCents, extrasCents: r.extrasCents, discountCents: r.discountCents,
    taxCents: r.taxCents, feesCents: r.feesCents, totalCents: r.totalCents, depositCents: r.depositCents, extraLineItems: (r.extras ?? []).map(e => ({ extraId: e.extraId, name: e.extra?.name ?? e.extraId, quantity: e.quantity, amountCents: e.amountCents })) };
}
