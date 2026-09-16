import Link from "next/link";
import { CalendarDays, PiggyBank, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";

const perks = [
  { icon: PiggyBank, text: "Discounted monthly rates vs. daily pricing" },
  { icon: Wrench, text: "Maintenance handled — one less thing to manage" },
  { icon: CalendarDays, text: "Flexible extensions as your plans change" },
];

export function LongTermCta() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
      <div className="relative overflow-hidden rounded-2xl border border-gold/20 bg-gradient-to-br from-card via-card to-surface p-8 sm:p-12">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-20"
          style={{ background: "radial-gradient(circle, #D4AF37, transparent 70%)" }}
        />
        <div className="relative grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
              Need a Car for a <span className="text-gradient-gold">Month or Longer?</span>
            </h2>
            <p className="mt-4 max-w-lg text-muted">
              Whether you&apos;re between vehicles, relocating to Dallas, or need reliable transportation
              for an extended project, our monthly rental plans give you the flexibility of a rental
              with the comfort of predictable, discounted pricing.
            </p>
            <Button asChild size="lg" className="mt-6 text-base">
              <Link href="/long-term-rentals">View Monthly Rentals</Link>
            </Button>
          </div>

          <div className="flex flex-col gap-4">
            {perks.map((perk) => (
              <div key={perk.text} className="flex items-center gap-4 rounded-lg border border-white/10 bg-background/60 p-4">
                <perk.icon className="h-5 w-5 shrink-0 text-gold" />
                <span className="text-sm text-silver">{perk.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
