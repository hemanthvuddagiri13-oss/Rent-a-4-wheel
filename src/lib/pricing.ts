import { bookingDays } from "@/lib/booking-time";
import type { Coupon, Extra, Vehicle } from "@prisma/client";

export type RateType = "DAILY" | "WEEKLY" | "MONTHLY";

export interface RateSelection {
  rateType: RateType;
  rateAmountCents: number;
  units: number;
  subtotalCents: number;
  days: number;
}

/**
 * Determine the rental duration in whole days (minimum 1) and pick the
 * pricing tier that applies. Longer stays automatically roll onto the
 * weekly/monthly rate so the customer is never charged more than the
 * equivalent of the longer-term rate for a stay of that length.
 */
export function selectRate(
  vehicle: Pick<Vehicle, "dailyRateCents" | "weeklyRateCents" | "monthlyRateCents">,
  pickupAt: Date,
  returnAt: Date,
  bookingTimezone?: string
): RateSelection {
  const days = Math.max(1, bookingDays(pickupAt, returnAt, bookingTimezone));

  if (days >= 28) {
    const units = Math.ceil(days / 30);
    return {
      rateType: "MONTHLY",
      rateAmountCents: vehicle.monthlyRateCents,
      units,
      subtotalCents: units * vehicle.monthlyRateCents,
      days,
    };
  }

  if (days >= 7) {
    const units = Math.ceil(days / 7);
    return {
      rateType: "WEEKLY",
      rateAmountCents: vehicle.weeklyRateCents,
      units,
      subtotalCents: units * vehicle.weeklyRateCents,
      days,
    };
  }

  return {
    rateType: "DAILY",
    rateAmountCents: vehicle.dailyRateCents,
    units: days,
    subtotalCents: days * vehicle.dailyRateCents,
    days,
  };
}

export interface ExtraSelection {
  extra: Pick<Extra, "id" | "name" | "chargeType" | "amountCents" | "percent">;
  quantity: number;
}

export interface PricingBreakdown {
  marketplace?: { platformFeeCents: number; protectionCents: number; processingCents: number; hostCommissionCents: number; hostEarningsCents: number; reserveCents: number; approval: "SAMPLE_UNAPPROVED" };
  rateType: RateType;
  rateAmountCents: number;
  units: number;
  days: number;
  subtotalCents: number;
  extrasCents: number;
  extraLineItems: Array<{ extraId: string; name: string; amountCents: number; quantity: number }>;
  discountCents: number;
  taxCents: number;
  feesCents: number;
  totalCents: number;
  depositCents: number;
}

export function calculatePricing(params: {
  vehicle: Pick<
    Vehicle,
    "dailyRateCents" | "weeklyRateCents" | "monthlyRateCents" | "securityDepositCents"
  >;
  pickupAt: Date;
  returnAt: Date;
  bookingTimezone?: string;
  extras?: ExtraSelection[];
  coupon?: Pick<Coupon, "discountType" | "amountCents" | "percent"> | null;
  taxRatePercent?: number;
  feesCents?: number;
}): PricingBreakdown {
  const { vehicle, pickupAt, returnAt, extras = [], coupon, taxRatePercent = 0, feesCents = 0 } = params;

  const rate = selectRate(vehicle, pickupAt, returnAt, params.bookingTimezone);

  const extraLineItems = extras.map(({ extra, quantity }) => {
    let amount = 0;
    if (extra.chargeType === "ONE_TIME") {
      amount = (extra.amountCents ?? 0) * quantity;
    } else if (extra.chargeType === "DAILY") {
      amount = (extra.amountCents ?? 0) * rate.days * quantity;
    } else if (extra.chargeType === "PERCENTAGE") {
      amount = Math.round((rate.subtotalCents * Number(extra.percent ?? 0)) / 100) * quantity;
    }
    return { extraId: extra.id, name: extra.name, amountCents: amount, quantity };
  });
  const extrasCents = extraLineItems.reduce((sum, l) => sum + l.amountCents, 0);

  let discountCents = 0;
  if (coupon) {
    const discountBase = rate.subtotalCents + extrasCents;
    if (coupon.discountType === "PERCENTAGE") {
      discountCents = Math.round((discountBase * Number(coupon.percent ?? 0)) / 100);
    } else if (coupon.discountType === "FIXED") {
      discountCents = Math.min(coupon.amountCents ?? 0, discountBase);
    }
  }

  const taxableAmount = Math.max(0, rate.subtotalCents + extrasCents - discountCents);
  const taxCents = Math.round((taxableAmount * taxRatePercent) / 100);

  const totalCents = taxableAmount + taxCents + feesCents;

  return {
    rateType: rate.rateType,
    rateAmountCents: rate.rateAmountCents,
    units: rate.units,
    days: rate.days,
    subtotalCents: rate.subtotalCents,
    extrasCents,
    extraLineItems,
    discountCents,
    taxCents,
    feesCents,
    totalCents,
    depositCents: vehicle.securityDepositCents,
  };
}

export function isCouponValid(
  coupon: Coupon,
  params: { rentalDays: number; vehicleId: string; now?: Date }
): { valid: boolean; reason?: string } {
  const now = params.now ?? new Date();
  if (!coupon.isActive) return { valid: false, reason: "This coupon is not currently active." };
  if (now < coupon.startsAt) return { valid: false, reason: "This coupon is not yet active." };
  if (now > coupon.expiresAt) return { valid: false, reason: "This coupon has expired." };
  if (coupon.minRentalDays && params.rentalDays < coupon.minRentalDays) {
    return { valid: false, reason: `This coupon requires a minimum rental of ${coupon.minRentalDays} days.` };
  }
  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, reason: "This coupon has reached its usage limit." };
  }
  if (coupon.applicableVehicleIds.length > 0 && !coupon.applicableVehicleIds.includes(params.vehicleId)) {
    return { valid: false, reason: "This coupon is not valid for the selected vehicle." };
  }
  return { valid: true };
}
