import { CarFront, CreditCard, FileCheck2, KeyRound, ListChecks } from "lucide-react";

const steps = [
  { icon: CarFront, title: "Choose Your Car", desc: "Browse our fleet and pick the vehicle that fits your trip." },
  { icon: ListChecks, title: "Select Your Dates", desc: "Tell us your pickup and return dates — daily, weekly, or monthly." },
  { icon: FileCheck2, title: "Verify Your Information", desc: "Provide driver details and upload your license securely." },
  { icon: CreditCard, title: "Pay & Reserve", desc: "Complete secure checkout and lock in your reservation." },
  { icon: KeyRound, title: "Pick Up & Drive", desc: "Grab your keys and hit the road." },
];

export function HowItWorks() {
  return (
    <section className="border-t border-white/10 bg-surface/40 py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
            How It Works
          </h2>
        </div>

        <div className="relative mt-14 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div className="absolute left-0 right-0 top-8 hidden h-px bg-gradient-to-r from-transparent via-gold/30 to-transparent lg:block" />
          {steps.map((step, i) => (
            <div key={step.title} className="relative flex flex-col items-center text-center">
              <div className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border border-gold/40 bg-background">
                <step.icon className="h-7 w-7 text-gold" />
                <span className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-gold text-xs font-bold text-black">
                  {i + 1}
                </span>
              </div>
              <h3 className="mt-4 font-display text-base font-semibold text-white">{step.title}</h3>
              <p className="mt-1.5 text-sm text-muted">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
