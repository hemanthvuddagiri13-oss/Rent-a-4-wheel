import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SearchWidget } from "@/components/home/search-widget";

export function Hero() {
  return <section className="relative border-b border-white/10 bg-surface pb-10 pt-12 sm:pb-16 sm:pt-20">
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="grid items-end gap-8 lg:grid-cols-[1.3fr_1fr] lg:gap-16">
        <div>
          <p className="mb-5 text-sm font-medium tracking-wide text-gold">Cars from independent hosts</p>
          <h1 className="max-w-3xl font-display text-5xl font-medium leading-[1.05] tracking-tight text-white sm:text-7xl lg:text-8xl">Drive More <span className="text-gold">Possibilities</span></h1>
        </div>
        <div className="max-w-md pb-2">
          <p className="text-lg leading-relaxed text-silver">A car for the plans you make. Explore available vehicles, choose your dates and see your trip costs before payment.</p>
          <Link href="/how-it-works" className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-white underline underline-offset-4">How car sharing works <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
        </div>
      </div>
      <div className="mt-10 sm:mt-14"><SearchWidget /></div>
      <p className="mt-4 text-sm text-muted">Availability, eligibility and approved terms depend on the vehicle and operating state.</p>
    </div>
  </section>;
}
