import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchWidget } from "@/components/home/search-widget";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-background pb-16 pt-16 sm:pb-24 sm:pt-20">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(212,175,55,0.18), transparent 70%)",
        }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,#050505_95%)]" />

      <div className="relative mx-auto flex max-w-7xl flex-col items-center px-4 text-center sm:px-6 lg:px-8">
        <span className="animate-fade-up mb-6 inline-flex items-center rounded-full border border-gold/30 bg-gold/5 px-4 py-1.5 text-xs font-medium uppercase tracking-[0.2em] text-gold-bright opacity-0 [animation-delay:0ms]">
          Dallas, Texas
        </span>

        <h1 className="animate-fade-up font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight text-white opacity-0 [animation-delay:80ms] sm:text-7xl lg:text-8xl">
          Drive More.
          <br />
          <span className="text-gradient-gold">Pay Less.</span>
        </h1>

        <p className="animate-fade-up mt-6 max-w-2xl text-lg font-medium text-silver opacity-0 [animation-delay:160ms] sm:text-xl">
          Daily, Weekly &amp; Monthly Car Rentals in Dallas
        </p>
        <p className="animate-fade-up mt-3 max-w-xl text-sm text-muted opacity-0 [animation-delay:220ms] sm:text-base">
          Clean, reliable vehicles with flexible rental options and competitive rates.
        </p>

        <div className="animate-fade-up mt-8 flex flex-col gap-3 opacity-0 [animation-delay:280ms] sm:flex-row">
          <Button asChild size="lg" className="text-base">
            <Link href="/vehicles">
              Find a Car <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="text-base">
            <Link href="/vehicles">View Vehicles</Link>
          </Button>
        </div>

        <div className="animate-fade-up mt-12 w-full opacity-0 [animation-delay:360ms]">
          <SearchWidget />
        </div>
      </div>
    </section>
  );
}
