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

export function VehicleCard({ vehicle, headingLevel = 3 }: { vehicle: VehicleCardData; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-card transition-colors duration-150 hover:border-silver/40">
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
        <Heading className="text-lg font-semibold leading-snug text-white">
          {vehicle.year} {vehicle.make} {vehicle.model}
          {vehicle.trim ? <span className="text-muted"> {vehicle.trim}</span> : null}
        </Heading>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted">
          <span className="flex items-center gap-1.5">
            <Users className="h-4 w-4 text-silver" /> {vehicle.seats} seats
          </span>
          <span className="flex items-center gap-1.5">
            <Settings2 className="h-4 w-4 text-silver" /> {vehicle.transmission === "AUTOMATIC" ? "Automatic" : "Manual"}
          </span>
          <span className="flex items-center gap-1.5">
            <Fuel className="h-4 w-4 text-silver" /> {vehicle.fuelType.charAt(0) + vehicle.fuelType.slice(1).toLowerCase()}
          </span>
          <span className="flex items-center gap-1.5">
            <Gauge className="h-4 w-4 text-silver" /> {vehicle.mileageAllowancePerDay}mi/day
          </span>
        </div>

        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="text-silver"><strong className="text-xl font-semibold text-white">{formatCurrency(vehicle.dailyRateCents)}</strong> / day</p>
          <p className="mt-1 text-sm text-muted">Rental rate before fees, taxes, extras and any deposit. Choose dates for your trip total.</p>
        </div>

        <div className="mt-5 flex gap-2">
          <Button asChild variant="secondary" className="flex-1">
            <Link href={`/vehicles/${vehicle.slug}`}>View Details</Link>
          </Button>

        </div>
      </div>
    </article>
  );
}
