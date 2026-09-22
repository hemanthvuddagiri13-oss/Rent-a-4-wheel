import { CalendarClock, HeadphonesIcon, MousePointerClick, ShieldCheck, Sparkles } from "lucide-react";

const items = [
  { icon: CalendarClock, label: "Flexible Rentals" },
  { icon: ShieldCheck, label: "Itemized pricing" },
  { icon: Sparkles, label: "Independent hosts" },
  { icon: MousePointerClick, label: "Online booking" },
  { icon: HeadphonesIcon, label: "Customer Support" },
];

export function TrustBar() {
  return (
    <section className="border-y border-white/10 bg-surface/60">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-8 sm:grid-cols-3 sm:px-6 lg:grid-cols-5 lg:px-8">
        {items.map(({ icon: Icon, label }) => (
          <div key={label} className="flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-center sm:gap-3">
            <Icon className="h-5 w-5 shrink-0 text-gold" />
            <span className="text-xs font-medium uppercase tracking-wide text-silver sm:text-sm">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
