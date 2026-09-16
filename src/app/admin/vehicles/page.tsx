import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = { title: "Vehicles", robots: { index: false } };
export const revalidate = 0;

const statusVariant: Record<string, "success" | "warning" | "secondary" | "destructive"> = {
  ACTIVE: "success",
  MAINTENANCE: "warning",
  INACTIVE: "secondary",
  RETIRED: "destructive",
};

export default async function AdminVehiclesPage() {
  const vehicles = await prisma.vehicle.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold text-white">Vehicles</h1>
        <Button asChild>
          <Link href="/admin/vehicles/new">
            <Plus className="h-4 w-4" /> Add Vehicle
          </Link>
        </Button>
      </div>

      <div className="mt-6 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-surface/60 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">VIN</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Daily Rate</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id} className="border-t border-white/5">
                <td className="px-4 py-3 font-medium text-white">
                  {v.year} {v.make} {v.model} {v.isDemo && <span className="text-muted">(sample)</span>}
                </td>
                <td className="px-4 py-3 text-muted">{v.vin}</td>
                <td className="px-4 py-3 text-silver">{v.category}</td>
                <td className="px-4 py-3 text-gold-bright">{formatCurrency(v.dailyRateCents)}</td>
                <td className="px-4 py-3">
                  <Badge variant={statusVariant[v.status]}>{v.status}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/admin/vehicles/${v.id}`} className="text-gold hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
