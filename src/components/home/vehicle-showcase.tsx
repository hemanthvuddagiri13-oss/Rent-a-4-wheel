"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { VehicleCard, type VehicleCardData } from "@/components/vehicles/vehicle-card";
import { VEHICLE_CATEGORY_LABELS } from "@/lib/constants";

const CATEGORIES = ["ALL", "SEDAN", "SUV", "LUXURY", "ECONOMY", "TRUCK"];

export function VehicleShowcase({ vehicles }: { vehicles: VehicleCardData[] }) {
  const [category, setCategory] = useState("ALL");

  const filtered = useMemo(
    () => (category === "ALL" ? vehicles : vehicles.filter((v) => v.category === category)),
    [vehicles, category]
  );

  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center gap-6 text-center">
        <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
          Find Your Perfect Ride
        </h2>

        <Tabs value={category} onValueChange={setCategory}>
          <TabsList className="flex-wrap h-auto">
            {CATEGORIES.map((cat) => (
              <TabsTrigger key={cat} value={cat}>
                {VEHICLE_CATEGORY_LABELS[cat]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.slice(0, 6).map((vehicle) => (
          <VehicleCard key={vehicle.id} vehicle={vehicle} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="mt-10 text-center text-muted">No vehicles currently available in this category.</p>
      )}

      <div className="mt-12 flex justify-center">
        <Button asChild variant="outline" size="lg">
          <Link href="/vehicles">
            View All Vehicles <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
