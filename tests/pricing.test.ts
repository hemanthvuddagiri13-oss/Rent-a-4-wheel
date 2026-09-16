import { describe, it, expect } from "vitest";
import { calculatePricing, isCouponValid, selectRate } from "@/lib/pricing";
import type { Coupon } from "@prisma/client";

const vehicle = {
  dailyRateCents: 5000,
  weeklyRateCents: 30000,
  monthlyRateCents: 90000,
  securityDepositCents: 35000,
};

function d(dateStr: string) {
  return new Date(dateStr);
}

describe("selectRate", () => {
  it("uses the daily rate for stays under a week", () => {
    const rate = selectRate(vehicle, d("2026-01-01"), d("2026-01-04"));
    expect(rate.rateType).toBe("DAILY");
    expect(rate.units).toBe(3);
    expect(rate.subtotalCents).toBe(15000);
  });

  it("rolls onto the weekly rate at 7+ days, billed in whole weeks", () => {
    const rate = selectRate(vehicle, d("2026-01-01"), d("2026-01-08")); // 7 days
    expect(rate.rateType).toBe("WEEKLY");
    expect(rate.units).toBe(1);
    expect(rate.subtotalCents).toBe(30000);
  });

  it("bills partial weeks as a full additional week", () => {
    const rate = selectRate(vehicle, d("2026-01-01"), d("2026-01-16")); // 15 days
    expect(rate.rateType).toBe("WEEKLY");
    expect(rate.units).toBe(3); // ceil(15/7)
  });

  it("rolls onto the monthly rate at 28+ days", () => {
    const rate = selectRate(vehicle, d("2026-01-01"), d("2026-01-29")); // 28 days
    expect(rate.rateType).toBe("MONTHLY");
    expect(rate.units).toBe(1);
    expect(rate.subtotalCents).toBe(90000);
  });

  it("never charges less than one day for a same-day range", () => {
    const rate = selectRate(vehicle, d("2026-01-01T10:00:00"), d("2026-01-01T14:00:00"));
    expect(rate.days).toBe(1);
    expect(rate.units).toBe(1);
  });
});

describe("calculatePricing", () => {
  it("computes subtotal, tax, and total with no extras or discount", () => {
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"),
      taxRatePercent: 8.25,
    });
    expect(breakdown.subtotalCents).toBe(15000);
    expect(breakdown.taxCents).toBe(Math.round(15000 * 0.0825));
    expect(breakdown.totalCents).toBe(breakdown.subtotalCents + breakdown.taxCents);
    expect(breakdown.depositCents).toBe(35000);
  });

  it("applies a one-time extra charge once regardless of rental length", () => {
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"),
      extras: [{ extra: { id: "x1", name: "Airport Pickup", chargeType: "ONE_TIME", amountCents: 2500, percent: null }, quantity: 1 }],
    });
    expect(breakdown.extrasCents).toBe(2500);
  });

  it("multiplies a daily extra charge by the number of rental days", () => {
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"), // 3 days
      extras: [{ extra: { id: "x2", name: "Child Seat", chargeType: "DAILY", amountCents: 800, percent: null }, quantity: 1 }],
    });
    expect(breakdown.extrasCents).toBe(800 * 3);
  });

  it("computes a percentage extra off the rental subtotal", () => {
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"), // subtotal 15000
      extras: [
        {
          extra: { id: "x3", name: "Service Fee", chargeType: "PERCENTAGE", amountCents: null, percent: 10 as unknown as Coupon["percent"] },
          quantity: 1,
        },
      ],
    });
    expect(breakdown.extrasCents).toBe(1500);
  });

  it("applies a percentage coupon discount to subtotal + extras", () => {
    const coupon: Pick<Coupon, "discountType" | "amountCents" | "percent"> = {
      discountType: "PERCENTAGE",
      amountCents: null,
      percent: 10 as unknown as Coupon["percent"],
    };
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"),
      coupon,
    });
    expect(breakdown.discountCents).toBe(1500); // 10% of 15000
  });

  it("caps a fixed coupon discount at the discountable base", () => {
    const coupon: Pick<Coupon, "discountType" | "amountCents" | "percent"> = {
      discountType: "FIXED",
      amountCents: 999999,
      percent: null,
    };
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"),
      coupon,
    });
    expect(breakdown.discountCents).toBe(15000);
    expect(breakdown.totalCents).toBe(0);
  });

  it("never lets tax go negative when a discount exceeds the subtotal", () => {
    const coupon: Pick<Coupon, "discountType" | "amountCents" | "percent"> = {
      discountType: "FIXED",
      amountCents: 999999,
      percent: null,
    };
    const breakdown = calculatePricing({
      vehicle,
      pickupAt: d("2026-01-01"),
      returnAt: d("2026-01-04"),
      coupon,
      taxRatePercent: 8.25,
    });
    expect(breakdown.taxCents).toBe(0);
  });
});

describe("isCouponValid", () => {
  const baseCoupon: Coupon = {
    id: "c1",
    code: "TESTCODE",
    discountType: "PERCENTAGE",
    amountCents: null,
    percent: 10 as unknown as Coupon["percent"],
    startsAt: d("2026-01-01"),
    expiresAt: d("2026-12-31"),
    minRentalDays: null,
    maxUses: null,
    usedCount: 0,
    applicableVehicleIds: [],
    isActive: true,
    createdAt: d("2026-01-01"),
    updatedAt: d("2026-01-01"),
  };

  it("rejects an inactive coupon", () => {
    const result = isCouponValid({ ...baseCoupon, isActive: false }, { rentalDays: 3, vehicleId: "v1", now: d("2026-06-01") });
    expect(result.valid).toBe(false);
  });

  it("rejects a coupon before its start date", () => {
    const result = isCouponValid(baseCoupon, { rentalDays: 3, vehicleId: "v1", now: d("2025-12-31") });
    expect(result.valid).toBe(false);
  });

  it("rejects an expired coupon", () => {
    const result = isCouponValid(baseCoupon, { rentalDays: 3, vehicleId: "v1", now: d("2027-01-01") });
    expect(result.valid).toBe(false);
  });

  it("rejects a coupon when the rental is shorter than the minimum", () => {
    const result = isCouponValid({ ...baseCoupon, minRentalDays: 7 }, { rentalDays: 3, vehicleId: "v1", now: d("2026-06-01") });
    expect(result.valid).toBe(false);
  });

  it("rejects a coupon that has hit its usage cap", () => {
    const result = isCouponValid(
      { ...baseCoupon, maxUses: 5, usedCount: 5 },
      { rentalDays: 3, vehicleId: "v1", now: d("2026-06-01") }
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a coupon not applicable to the selected vehicle", () => {
    const result = isCouponValid(
      { ...baseCoupon, applicableVehicleIds: ["other-vehicle"] },
      { rentalDays: 3, vehicleId: "v1", now: d("2026-06-01") }
    );
    expect(result.valid).toBe(false);
  });

  it("accepts a valid, active coupon within all constraints", () => {
    const result = isCouponValid(
      { ...baseCoupon, minRentalDays: 2, maxUses: 10, usedCount: 3, applicableVehicleIds: ["v1"] },
      { rentalDays: 3, vehicleId: "v1", now: d("2026-06-01") }
    );
    expect(result.valid).toBe(true);
  });
});
