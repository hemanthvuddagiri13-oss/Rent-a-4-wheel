import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CouponToggle } from "@/components/admin/coupon-toggle";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = { title: "Coupons", robots: { index: false } };
export const revalidate = 0;

export default async function AdminCouponsPage() {
  const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold text-white">Coupons</h1>
        <Button asChild>
          <Link href="/admin/coupons/new">
            <Plus className="h-4 w-4" /> Add Coupon
          </Link>
        </Button>
      </div>

      <div className="mt-6 space-y-3">
        {coupons.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-card p-4">
            <div>
              <p className="font-display font-semibold text-white">{c.code}</p>
              <p className="text-sm text-muted">
                {c.discountType === "PERCENTAGE" ? `${c.percent}% off` : `${formatCurrency(c.amountCents ?? 0)} off`} &middot; used {c.usedCount}
                {c.maxUses ? `/${c.maxUses}` : ""} times &middot; expires {c.expiresAt.toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={c.isActive ? "success" : "secondary"}>{c.isActive ? "Active" : "Inactive"}</Badge>
              <CouponToggle couponId={c.id} isActive={c.isActive} />
            </div>
          </div>
        ))}
        {coupons.length === 0 && <p className="text-sm text-muted">No coupons created yet.</p>}
      </div>
    </div>
  );
}
