import { BadgeDollarSign, CalendarRange, Headset, MapPinned, Sparkles, Zap } from "lucide-react";

const items = [
  { icon: BadgeDollarSign, title: "Affordable Pricing", desc: "Transparent daily, weekly, and monthly rates with no hidden fees." },
  { icon: CalendarRange, title: "Daily / Weekly / Monthly", desc: "Flexible rental lengths that fit your schedule and budget." },
  { icon: Sparkles, title: "Clean & Maintained Vehicles", desc: "Every vehicle is inspected, cleaned, and maintenance-tracked." },
  { icon: Zap, title: "Fast Booking", desc: "Reserve your car online in minutes — no waiting in line." },
  { icon: MapPinned, title: "Flexible Pickup", desc: "Convenient pickup options across the Dallas area." },
  { icon: Headset, title: "Customer Support", desc: "Real support when you need it, before and during your rental." },
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
