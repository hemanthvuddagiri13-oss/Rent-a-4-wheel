import type { Metadata } from "next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createCoupon } from "@/app/admin/coupons/actions";

export const metadata: Metadata = { title: "Add Coupon", robots: { index: false } };

export default function NewCouponPage() {
  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl font-bold text-white">Add Coupon</h1>
      <form action={createCoupon} className="mt-6 space-y-4 rounded-xl border border-white/10 bg-card p-5">
        <div>
          <Label htmlFor="code">Promo Code</Label>
          <Input id="code" name="code" required placeholder="WELCOME10" className="mt-1.5 uppercase" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="discountType">Discount Type</Label>
            <select id="discountType" name="discountType" className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white">
              <option value="PERCENTAGE">Percentage</option>
              <option value="FIXED">Fixed Amount</option>
            </select>
          </div>
          <div>
            <Label htmlFor="percent">Percent (%)</Label>
            <Input id="percent" name="percent" type="number" step="0.01" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="amount">Fixed Amount ($)</Label>
            <Input id="amount" name="amount" type="number" step="0.01" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="minRentalDays">Minimum Rental Days</Label>
            <Input id="minRentalDays" name="minRentalDays" type="number" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="maxUses">Maximum Uses</Label>
            <Input id="maxUses" name="maxUses" type="number" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="startsAt">Start Date</Label>
            <Input id="startsAt" name="startsAt" type="date" required className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="expiresAt">Expiration Date</Label>
            <Input id="expiresAt" name="expiresAt" type="date" required className="mt-1.5" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input id="isActive" name="isActive" type="checkbox" className="h-4 w-4 rounded border-white/25 bg-card accent-gold" />
          <Label htmlFor="isActive">Activate immediately</Label>
        </div>
        <Button type="submit" size="lg">
          Create Coupon
        </Button>
      </form>
    </div>
  );
}
