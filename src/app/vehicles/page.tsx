import Link from "next/link";
import { Suspense } from "react";
import VehicleSearchLoading from "@/components/vehicles/vehicle-search-loading";
import { Button } from "@/components/ui/button";
import type { Metadata } from "next";
import { bookingInstant } from "@/lib/booking-time";
import { getSiteSettings } from "@/lib/settings";
import { SearchWidget } from "@/components/home/search-widget";
import { VehicleFilters, SortSelect, ActiveFilterChips } from "@/components/vehicles/vehicle-filters";
import { VehicleCard } from "@/components/vehicles/vehicle-card";
import { searchVehicles, getDistinctMakes, getDistinctLocations, type VehicleSearchFilters } from "@/lib/data/vehicles";

export const metadata: Metadata = {
  title: "Browse Vehicles",
  description:
    "Explore available cars from independent hosts. Choose dates and compare rental options.",
  alternates: { canonical: "/vehicles" },
};

export const revalidate = 0;

function parseDate(dateStr: string | undefined, timeStr: string | undefined, zone: string): Date | undefined {
  if (!dateStr) return undefined;
  return bookingInstant(`${dateStr}T${timeStr || "10:00"}`, zone);
}

export default function VehiclesPage(props: {searchParams: Promise<Record<string,string|undefined>>}) {
  return <Suspense fallback={<VehicleSearchLoading/>}><VehicleResults {...props}/></Suspense>;
}

async function VehicleResults({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;

  const zone = (await getSiteSettings()).bookingTimezone;
  let pickupAt: Date | undefined, returnAt: Date | undefined;
  let dateError = "";
  try { pickupAt = parseDate(sp.pickupDate, sp.pickupTime, zone); returnAt = parseDate(sp.returnDate, sp.returnTime, zone); if ((pickupAt && !returnAt) || (!pickupAt && returnAt) || (pickupAt && returnAt && returnAt <= pickupAt)) throw new Error("Choose a return after pickup."); } catch (error) { dateError = error instanceof Error ? error.message : "Invalid dates."; }
  const filters: VehicleSearchFilters = {
    pickupAt, returnAt, location: sp.location,
    category: sp.category,
    priceMin: sp.priceMin ? Number(sp.priceMin) : undefined,
    priceMax: sp.priceMax ? Number(sp.priceMax) : undefined,
    seats: sp.seats ? Number(sp.seats) : undefined,
    make: sp.make,
    transmission: sp.transmission,
    sort: (sp.sort as VehicleSearchFilters["sort"]) ?? "recommended",
  };

  const [vehicles, makes, locations] = await Promise.all([dateError ? Promise.resolve([]) : searchVehicles(filters), getDistinctMakes(), getDistinctLocations()]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
          Find your next car
        </h1>
        <p className="mt-2 text-muted">
          {filters.pickupAt && filters.returnAt
            ? "Showing vehicles available for your selected dates."
            : "Select your dates to see live availability."}
        </p>
      </div>

      <div className="mb-8"><SearchWidget key={JSON.stringify(sp)} locations={locations} initial={sp} /><p className="mt-2 text-xs text-silver">Times are in {zone}.</p>{dateError && <p role="alert" className="mt-3 text-red-300">{dateError}</p>}</div>
      <div className="flex flex-col gap-8 lg:flex-row">
        <VehicleFilters makes={makes} />

        <div className="min-w-0 flex-1">
          <ActiveFilterChips />
          <div className="mb-6 hidden items-center justify-between lg:flex">
            <p className="text-sm text-muted">{vehicles.length} vehicles found</p>
            <SortSelect />
          </div>

          {vehicles.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-card py-24 text-center">
              <p className="font-display text-xl font-semibold text-white">No vehicles match your search</p>
              <p className="mt-2 max-w-sm text-sm text-muted">
                Try different dates or clear your filters. Vehicles in unavailable operating states cannot be booked.
              </p>
              <Button asChild variant="outline" className="mt-5"><Link href="/vehicles">Clear dates and filters</Link></Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {vehicles.map((vehicle) => (
                <VehicleCard key={vehicle.id} vehicle={vehicle} headingLevel={2} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
