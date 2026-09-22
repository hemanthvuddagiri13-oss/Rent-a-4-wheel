import Link from "next/link";
import { Button } from "@/components/ui/button";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-white/10 py-24">
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{ backgroundImage: "radial-gradient(ellipse 50% 60% at 50% 50%, rgba(212,175,55,0.25), transparent 70%)" }}
      />
      <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
        <h2 className="font-display text-4xl font-bold uppercase tracking-tight text-white sm:text-5xl">
          Ready to <span className="text-gradient-gold">Hit the Road?</span>
        </h2>
        <p className="mt-4 text-lg text-muted">Explore available cars and plan your next trip.</p>
        <Button asChild size="lg" className="mt-8 text-base">
          <Link href="/vehicles">Book Your Car</Link>
        </Button>
      </div>
    </section>
  );
}
