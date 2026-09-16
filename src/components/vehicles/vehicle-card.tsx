import Image from "next/image";
import Link from "next/link";
import { Fuel, Gauge, Settings2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { VEHICLE_CATEGORY_LABELS } from "@/lib/constants";

export interface VehicleCardData {
  id: string;
  slug: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  category: string;
  seats: number;
  transmission: string;
  fuelType: string;
  mileageAllowancePerDay: number;
  dailyRateCents: number;
  weeklyRateCents: number;
  monthlyRateCents: number;
  imageUrl: string | null;
}

export function VehicleCard({ vehicle }: { vehicle: VehicleCardData }) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-card transition-all duration-300 hover:-translate-y-1 hover:border-gold/40 hover:shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-surface">
        <Image
          src={vehicle.imageUrl || "/images/vehicles/sedan.svg"}
          alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
          fill
          sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <Badge className="absolute left-3 top-3 backdrop-blur">
          {VEHICLE_CATEGORY_LABELS[vehicle.category] ?? vehicle.category}
        </Badge>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h3 className="font-display text-lg font-semibold text-white">
          {vehicle.year} {vehicle.make} {vehicle.model}
          {vehicle.trim ? <span className="text-muted"> {vehicle.trim}</span> : null}
        </h3>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-gold" /> {vehicle.seats} seats
          </span>
          <span className="flex items-center gap-1.5">
            <Settings2 className="h-3.5 w-3.5 text-gold" /> {vehicle.transmission === "AUTOMATIC" ? "Automatic" : "Manual"}
          </span>
          <span className="flex items-center gap-1.5">
            <Fuel className="h-3.5 w-3.5 text-gold" /> {vehicle.fuelType.charAt(0) + vehicle.fuelType.slice(1).toLowerCase()}
          </span>
          <span className="flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-gold" /> {vehicle.mileageAllowancePerDay}mi/day
          </span>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-surface/60 p-3 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">Daily</p>
            <p className="font-display text-sm font-semibold text-gold-bright">{formatCurrency(vehicle.dailyRateCents)}</p>
          </div>
          <div className="border-x border-white/10">
            <p className="text-[10px] uppercase tracking-wide text-muted">Weekly</p>
            <p className="font-display text-sm font-semibold text-gold-bright">{formatCurrency(vehicle.weeklyRateCents)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">Monthly</p>
            <p className="font-display text-sm font-semibold text-gold-bright">{formatCurrency(vehicle.monthlyRateCents)}</p>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <Button asChild variant="outline" className="flex-1">
            <Link href={`/vehicles/${vehicle.slug}`}>View Details</Link>
          </Button>
          <Button asChild className="flex-1">
            <Link href={`/vehicles/${vehicle.slug}#book`}>Book Now</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
