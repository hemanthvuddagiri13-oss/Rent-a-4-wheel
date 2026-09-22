import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SearchWidget } from "@/components/home/search-widget";
import { getDistinctLocations } from "@/lib/data/vehicles";

export async function Hero() {
  const locations = await getDistinctLocations();
  return <section className="relative border-b border-white/10 bg-surface pb-10 pt-12 sm:pb-16 sm:pt-20">
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="grid min-w-0 grid-cols-1 items-end gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-16">
        <div>
          <p className="mb-5 text-sm font-medium tracking-wide text-gold">Cars from independent hosts</p>
          <h1 className="max-w-3xl break-words font-display text-[clamp(2rem,9vw,3rem)] font-medium leading-[1.05] tracking-tight text-white sm:text-7xl lg:text-8xl">Drive More <span className="text-gold">Possibilities</span></h1>
        </div>
        <div className="min-w-0 max-w-md pb-2">
          <p className="text-lg leading-relaxed text-silver">A car for the plans you make. Explore available vehicles, choose your dates and see your trip costs before payment.</p>
          <Link href="/how-it-works" className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-white underline underline-offset-4">How car sharing works <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
        </div>
      </div>
      <div className="mt-10 sm:mt-14"><SearchWidget locations={locations} /></div>
      <p className="mt-4 text-sm text-muted">Availability, eligibility and approved terms depend on the vehicle and operating state.</p>
    </div>
  </section>;
}
