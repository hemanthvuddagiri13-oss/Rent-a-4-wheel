import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = { title: "Vehicle Owners", robots: { index: false } };
export const revalidate = 0;

export default async function AdminOwnersPage() {
  const owners = await prisma.vehicleOwner.findMany({
    include: { vehicles: true, agreements: { orderBy: { startDate: "desc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold text-white">Vehicle Owners</h1>
        <Button asChild>
          <Link href="/admin/owners/new">
            <Plus className="h-4 w-4" /> Add Owner
          </Link>
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted">Internal only — never exposed on the public site.</p>

      <div className="mt-6 space-y-3">
        {owners.map((o) => {
          const agreement = o.agreements[0];
          return (
            <div key={o.id} className="rounded-xl border border-white/10 bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-white">{o.name}</p>
                  <p className="text-sm text-muted">
                    {o.email} {o.phone && `· ${o.phone}`}
                  </p>
                </div>
                <p className="text-sm text-silver">{o.vehicles.length} vehicle(s)</p>
              </div>
              {agreement && (
                <p className="mt-2 text-sm text-muted">
                  {agreement.paymentArrangement === "MONTHLY_FIXED"
                    ? `Monthly fixed: ${formatCurrency(agreement.monthlyFixedCents ?? 0)}`
                    : `Revenue share: ${agreement.revenueSharePercent}%`}{" "}
                  &middot; since {agreement.startDate.toLocaleDateString()}
                </p>
              )}
            </div>
          );
        })}
        {owners.length === 0 && <p className="text-sm text-muted">No vehicle owners on file yet.</p>}
      </div>
    </div>
  );
}
