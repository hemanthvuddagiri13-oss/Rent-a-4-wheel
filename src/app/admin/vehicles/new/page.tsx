import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { VehicleForm } from "@/components/admin/vehicle-form";
import { createVehicle } from "@/app/admin/vehicles/actions";

export const metadata: Metadata = { title: "Add Vehicle", robots: { index: false } };

export default async function NewVehiclePage() {
  const owners = await prisma.vehicleOwner.findMany({ orderBy: { name: "asc" } });

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-white">Add Vehicle</h1>
      <div className="mt-6">
        <VehicleForm action={createVehicle} owners={owners} submitLabel="Add Vehicle" />
      </div>
    </div>
  );
}
