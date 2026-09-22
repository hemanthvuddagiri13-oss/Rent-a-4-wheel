import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = { title: "Maintenance", robots: { index: false } };
export const revalidate = 0;

export default async function AdminMaintenancePage() {
  const records = await prisma.maintenanceRecord.findMany({
    include: { vehicle: true },
    orderBy: { serviceDate: "desc" },
    take: 100,
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-bold text-white">Maintenance</h1>
        <Button asChild>
          <Link href="/admin/maintenance/new">
            <Plus className="h-4 w-4" /> Log Service
          </Link>
        </Button>
      </div>

      {records.length === 0 ? <p className="mt-6 rounded-xl border border-white/10 bg-card p-6 text-silver">No maintenance records logged yet.</p> : <div role="region" aria-label="Maintenance records" tabIndex={0} className="mt-6 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-surface/60 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Mileage</th>
              <th className="px-4 py-3">Cost</th>
              <th className="px-4 py-3">Vendor</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="px-4 py-3 text-white">
                  {r.vehicle.year} {r.vehicle.make} {r.vehicle.model}
                </td>
                <td className="px-4 py-3 text-silver">{r.service.replace(/_/g, " ")}</td>
                <td className="px-4 py-3 text-muted">{r.serviceDate.toLocaleDateString()}</td>
                <td className="px-4 py-3 text-muted">{r.mileage.toLocaleString()} mi</td>
                <td className="px-4 py-3 text-gold-bright">{formatCurrency(r.costCents)}</td>
                <td className="px-4 py-3 text-muted">{r.vendor}</td>
              </tr>
            ))}

          </tbody>
        </table>
      </div>}
    </div>
  );
}
