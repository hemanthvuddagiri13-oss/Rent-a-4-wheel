import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { VehicleForm } from "@/components/admin/vehicle-form";
import { DeleteVehicleButton } from "@/components/admin/delete-vehicle-button";
import { updateVehicle } from "@/app/admin/vehicles/actions";

export const metadata: Metadata = { title: "Edit Vehicle", robots: { index: false } };

export default async function EditVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [vehicle, owners] = await Promise.all([
    prisma.vehicle.findUnique({ where: { id }, include: { images: { orderBy: { position: "asc" } } } }),
    prisma.vehicleOwner.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!vehicle) notFound();

  const updateWithId = updateVehicle.bind(null, id);

  return (
    <div className="max-w-3xl">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <h1 className="font-display text-3xl font-bold text-white">
          Edit {vehicle.year} {vehicle.make} {vehicle.model}
        </h1>
        <DeleteVehicleButton vehicleId={vehicle.id} />
      </div>
      <div className="mt-6">
        <VehicleForm
          action={updateWithId}
          owners={owners}
          defaults={{ ...vehicle, imageUrls: vehicle.images.map((i) => i.url) }}
        />
      </div>
    </div>
  );
}
