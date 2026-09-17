import Link from "next/link";
import { bookingLocal } from "@/lib/booking-time";
export function AvailabilityCalendar({ vehicleId, month, zone, periods }: { vehicleId: string; month: string; zone: string; periods: { start: Date; end: Date; label: string }[] }) {
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  const start = new Date(`${valid}-01T12:00:00Z`), year = start.getUTCFullYear(), index = start.getUTCMonth();
  const count = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  const previous = new Date(Date.UTC(year, index - 1, 1)).toISOString().slice(0, 7), next = new Date(Date.UTC(year, index + 1, 1)).toISOString().slice(0, 7);
  const ranges = periods.map(p => ({ ...p, from: bookingLocal(p.start, zone).slice(0, 10), to: bookingLocal(new Date(p.end.getTime() - 1), zone).slice(0, 10) }));
  return <div className="mb-7"><div className="mb-5 flex items-center justify-between gap-3"><Link aria-label="Previous month" href={`/host/vehicles/${vehicleId}?month=${previous}`} className="rounded-lg border border-white/20 px-4 py-3 text-gold-bright">←</Link><h3 className="text-white">{start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</h3><Link aria-label="Next month" href={`/host/vehicles/${vehicleId}?month=${next}`} className="rounded-lg border border-white/20 px-4 py-3 text-gold-bright">→</Link></div><div className="grid grid-cols-7 gap-1 text-center text-xs">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => <div key={day} className="py-2 text-muted">{day}</div>)}{Array.from({ length: start.getUTCDay() }, (_, i) => <div key={`blank-${i}`} />)}{Array.from({ length: count }, (_, i) => {
    const day = `${valid}-${String(i + 1).padStart(2, "0")}`, occupied = ranges.filter(p => p.from <= day && p.to >= day);
    return <div key={day} title={occupied.map(p => p.label).join(", ") || "No recorded booking or block"} className={`rounded-md border py-3 ${occupied.length ? "border-gold/30 bg-gold/15 text-gold-bright" : "border-white/10 text-silver"}`}><span>{i + 1}</span><span className="sr-only">{occupied.length ? " includes a booking or block" : " no recorded booking or block"}</span></div>;
  })}</div><p className="mt-3 text-xs text-muted">{zone}. Gold dates include a booking or calendar block; exact pickup and return times still apply. Listing approval and availability settings also determine whether a vehicle can be booked.</p></div>;
}
