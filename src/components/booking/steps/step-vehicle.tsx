import Image from "next/image";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import type { BookingVehicle } from "@/components/booking/types";

export function StepVehicle({ vehicle, onNext }: { vehicle: BookingVehicle; onNext: () => void }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-semibold text-white">Confirm Your Vehicle</h2>
      <p className="mt-1 text-sm text-muted">You&apos;re booking the following vehicle.</p>

      <div className="mt-6 flex flex-col gap-4 rounded-xl border border-white/10 bg-card p-5 sm:flex-row sm:items-center">
        <div className="relative h-40 w-full shrink-0 overflow-hidden rounded-lg bg-surface sm:h-24 sm:w-36">
          <Image src={vehicle.imageUrl || "/images/vehicles/sedan.svg"} alt="" fill className="object-cover" />
        </div>
        <div className="flex-1">
          <h3 className="font-display text-lg font-semibold text-white">
            {vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}
          </h3>
          <p className="mt-1 text-sm text-gold-bright">{formatCurrency(vehicle.dailyRateCents)}/day</p>
        </div>
      </div>

      <Button size="lg" className="mt-8 w-full sm:w-auto" onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}
