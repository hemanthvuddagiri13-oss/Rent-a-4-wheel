import type { Metadata } from "next";
import Link from "next/link";
import { CarFront, CreditCard, FileCheck2, KeyRound, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "How It Works",
  description: "Renting a car from Rent A 4Wheel in Dallas is simple — here's how it works from booking to pickup.",
  alternates: { canonical: "/how-it-works" },
};

const steps = [
  { icon: CarFront, title: "Choose Your Car", desc: "Browse our fleet of sedans, SUVs, luxury vehicles, and trucks. Filter by dates, category, and price to find the right fit." },
  { icon: ListChecks, title: "Select Your Dates", desc: "Pick your pickup and return dates. Renting for a week or a month? We'll automatically apply the best weekly or monthly rate." },
  { icon: FileCheck2, title: "Verify Your Information", desc: "Create an account, provide your driver information, and securely upload your license — front and back." },
  { icon: CreditCard, title: "Pay & Reserve", desc: "Review a fully transparent price breakdown — rental, taxes, fees, and deposit — then complete secure checkout." },
  { icon: KeyRound, title: "Pick Up & Drive", desc: "Meet us at pickup, complete a quick vehicle walkthrough, and hit the road." },
];

export default function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight text-white">How It Works</h1>
        <p className="mt-3 text-muted">From browsing to driving — here&apos;s what to expect.</p>
      </div>

      <div className="mt-14 space-y-8">
        {steps.map((step, i) => (
          <div key={step.title} className="flex gap-5 rounded-xl border border-white/10 bg-card p-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-gold/30 bg-gold/10">
              <step.icon className="h-6 w-6 text-gold" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">Step {i + 1}</p>
              <h2 className="mt-1 font-display text-xl font-semibold text-white">{step.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-14 text-center">
        <Button asChild size="lg">
          <Link href="/vehicles">Find Your Car</Link>
        </Button>
      </div>
    </div>
  );
}
