import { BadgeDollarSign, CalendarRange, Headset, MapPinned, Sparkles, Zap } from "lucide-react";

const items = [
  { icon: BadgeDollarSign, title: "Itemized trip costs", desc: "Review rental costs, extras, fees, protection, taxes and any deposit separately before payment." },
  { icon: CalendarRange, title: "Daily / Weekly / Monthly", desc: "Flexible rental lengths that fit your schedule and budget." },
  { icon: Sparkles, title: "Independent hosts", desc: "Hosts store, maintain, deliver and retrieve their vehicles, including the physical handoff." },
  { icon: Zap, title: "Booking in one place", desc: "Reserve your car online in minutes — no waiting in line." },
  { icon: MapPinned, title: "Plan your pickup", desc: "Review the listing location and coordinate the available handoff options with your host." },
  { icon: Headset, title: "Customer Support", desc: "Keep booking questions and support requests connected to your reservation." },
];

export function WhyUs() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl">
          Why <span className="text-gradient-gold">Rent A 4Wheel</span>
        </h2>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ icon: Icon, title, desc }) => (
          <div
            key={title}
            className="group rounded-xl border border-white/10 bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-gold/40"
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-gold/30 bg-gold/10 transition-colors group-hover:bg-gold/20">
              <Icon className="h-6 w-6 text-gold" />
            </div>
            <h3 className="font-display text-lg font-semibold text-white">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
