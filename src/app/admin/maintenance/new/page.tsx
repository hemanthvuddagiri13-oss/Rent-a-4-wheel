import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { createMaintenanceRecord } from "@/app/admin/maintenance/actions";

export const metadata: Metadata = { title: "Log Maintenance", robots: { index: false } };

const SERVICES = ["OIL_CHANGE", "TIRES", "BRAKES", "INSPECTION", "REGISTRATION", "INSURANCE", "REPAIR", "CLEANING", "OTHER"];

export default async function NewMaintenancePage() {
  const vehicles = await prisma.vehicle.findMany({ orderBy: { make: "asc" } });

  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl font-bold text-white">Log Maintenance</h1>
      <form action={createMaintenanceRecord} className="mt-6 space-y-4 rounded-xl border border-white/10 bg-card p-5">
        <div>
          <Label htmlFor="vehicleId">Vehicle</Label>
          <select id="vehicleId" name="vehicleId" required className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white">
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.year} {v.make} {v.model}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="service">Service</Label>
            <select id="service" name="service" required className="mt-1.5 flex h-11 w-full rounded-md border border-white/15 bg-card px-3 text-sm text-white">
              {SERVICES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="serviceDate">Service Date</Label>
            <Input id="serviceDate" name="serviceDate" type="date" required className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="mileage">Mileage</Label>
            <Input id="mileage" name="mileage" type="number" required className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="cost">Cost ($)</Label>
            <Input id="cost" name="cost" type="number" step="0.01" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="vendor">Vendor</Label>
            <Input id="vendor" name="vendor" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="nextServiceDate">Next Service Date</Label>
            <Input id="nextServiceDate" name="nextServiceDate" type="date" className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="nextServiceMileage">Next Service Mileage</Label>
            <Input id="nextServiceMileage" name="nextServiceMileage" type="number" className="mt-1.5" />
          </div>
        </div>
        <div>
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" className="mt-1.5" rows={3} />
        </div>
        <Button type="submit" size="lg">
          Save Record
        </Button>
      </form>
    </div>
  );
}
