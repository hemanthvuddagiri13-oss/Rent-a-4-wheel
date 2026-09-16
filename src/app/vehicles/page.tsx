import type { Metadata } from "next";
import { VehicleFilters, SortSelect } from "@/components/vehicles/vehicle-filters";
import { VehicleCard } from "@/components/vehicles/vehicle-card";
import { searchVehicles, getDistinctMakes, type VehicleSearchFilters } from "@/lib/data/vehicles";

export const metadata: Metadata = {
  title: "Browse Vehicles",
  description:
    "Browse our full fleet of sedans, SUVs, luxury cars, and trucks available for daily, weekly, and monthly rental in Dallas, TX.",
  alternates: { canonical: "/vehicles" },
};

export const revalidate = 0;

function parseDate(dateStr?: string, timeStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  const iso = `${dateStr}T${timeStr || "10:00"}:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;

  const filters: VehicleSearchFilters = {
    pickupAt: parseDate(sp.pickupDate, sp.pickupTime),
    returnAt: parseDate(sp.returnDate, sp.returnTime),
    category: sp.category,
    priceMin: sp.priceMin ? Number(sp.priceMin) : undefined,
    priceMax: sp.priceMax ? Number(sp.priceMax) : undefined,
    seats: sp.seats ? Number(sp.seats) : undefined,
    make: sp.make,
    transmission: sp.transmission,
    sort: (sp.sort as VehicleSearchFilters["sort"]) ?? "recommended",
  };

  const [vehicles, makes] = await Promise.all([searchVehicles(filters), getDistinctMakes()]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
          Browse Our Fleet
        </h1>
        <p className="mt-2 text-muted">
          {filters.pickupAt && filters.returnAt
            ? "Showing vehicles available for your selected dates."
            : "Select your dates to see live availability."}
        </p>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row">
        <VehicleFilters makes={makes} />

        <div className="flex-1">
          <div className="mb-6 hidden items-center justify-between lg:flex">
            <p className="text-sm text-muted">{vehicles.length} vehicles found</p>
            <SortSelect />
          </div>

          {vehicles.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-card py-24 text-center">
              <p className="font-display text-xl font-semibold text-white">No vehicles match your search</p>
              <p className="mt-2 max-w-sm text-sm text-muted">
                Try adjusting your dates or filters, or view our full fleet.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {vehicles.map((vehicle) => (
                <VehicleCard key={vehicle.id} vehicle={vehicle} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
