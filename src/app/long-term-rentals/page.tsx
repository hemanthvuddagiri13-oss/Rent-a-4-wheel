import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, PiggyBank, ShieldCheck, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VehicleCard } from "@/components/vehicles/vehicle-card";
import { getFeaturedVehicles } from "@/lib/data/vehicles";

export const metadata: Metadata = {
  title: "Long-Term Car Rentals in Dallas",
  description:
    "Need a car for a month or longer? Rent A 4Wheel offers discounted monthly rental rates with flexible terms in Dallas, TX.",
  alternates: { canonical: "/long-term-rentals" },
};

const perks = [
  { icon: PiggyBank, title: "Discounted Monthly Rates", desc: "Save significantly compared to daily pricing when you rent by the month." },
  { icon: Wrench, title: "Maintenance Included", desc: "Routine maintenance is handled by us — one less thing on your plate." },
  { icon: CalendarDays, title: "Flexible Terms", desc: "Extend or adjust your rental as your plans change." },
  { icon: ShieldCheck, title: "Same Trusted Fleet", desc: "The same clean, well-maintained vehicles you'd get for a short-term rental." },
];

export const revalidate = 300;

export default async function LongTermRentalsPage() {
  const vehicles = await getFeaturedVehicles(6);

  return (
    <div>
      <section className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6 lg:px-8">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight text-white sm:text-5xl">
          Need a Car for a <span className="text-gradient-gold">Month or Longer?</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-muted">
          Whether you&apos;re between vehicles, relocating to Dallas, or need reliable transportation for an
          extended project, our monthly rental plans give you the flexibility of a rental with the comfort of
          predictable, discounted pricing.
        </p>
        <Button asChild size="lg" className="mt-8">
          <Link href="/vehicles">View Available Vehicles</Link>
        </Button>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {perks.map((p) => (
            <div key={p.title} className="rounded-xl border border-white/10 bg-card p-5">
              <p.icon className="h-6 w-6 text-gold" />
              <h3 className="mt-3 font-display font-semibold text-white">{p.title}</h3>
              <p className="mt-1.5 text-sm text-muted">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
        <h2 className="text-center font-display text-2xl font-bold uppercase tracking-tight text-white">
          Popular for Monthly Rentals
        </h2>
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {vehicles.map((v) => (
            <VehicleCard key={v.id} vehicle={v} />
          ))}
        </div>
      </section>
    </div>
  );
}
