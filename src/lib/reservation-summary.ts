import type { Reservation } from "@prisma/client";
export function pricingSummary(r: Reservation) {
  return { rateType: r.rateType, rateAmountCents: r.rateAmountCents, units: r.units,
    days: Math.max(1, Math.ceil((r.returnAt.getTime() - r.pickupAt.getTime()) / 86400000)),
    subtotalCents: r.subtotalCents, extrasCents: r.extrasCents, discountCents: r.discountCents,
    taxCents: r.taxCents, feesCents: r.feesCents, totalCents: r.totalCents, depositCents: r.depositCents, extraLineItems: [] };
}
