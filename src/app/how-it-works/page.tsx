import type { Metadata } from "next";
import Link from "next/link";
import { CarFront, CreditCard, FileCheck2, KeyRound, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "How It Works",
  description: "Book with independent vehicle hosts through Rent A 4Wheel. Learn about verification, transparent pricing and host handoffs.",
  alternates: { canonical: "/how-it-works" },
};

const steps = [
  { icon: CarFront, title: "Choose Your Car", desc: "Browse vehicles offered by independent hosts in available markets. Filter by dates, category, and price to find the right fit." },
  { icon: ListChecks, title: "Select Your Dates", desc: "Choose pickup and return dates, then review the available rate and itemized quote before booking." },
  { icon: FileCheck2, title: "Verify Your Information", desc: "Create an account, provide your driver information, and securely upload your license — front and back." },
  { icon: CreditCard, title: "Pay & Reserve", desc: "Review a fully transparent price breakdown — rental, taxes, fees, and deposit — then complete secure checkout." },
  { icon: KeyRound, title: "Pick Up & Drive", desc: "Arrange pickup with your host, verify the handoff and record the vehicle condition before starting your trip." },
];

export default function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight text-white">How It Works</h1>
        <p className="mt-3 text-muted">From browsing to driving — here&apos;s what to expect.</p>
        <p className="mt-5 text-sm text-muted">Hosts are independent vehicle providers. They store, maintain, deliver and retrieve their vehicles and handle physical handoffs. Rent A 4Wheel provides booking, payments, verification, agreements, support and claims workflows.</p>
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
