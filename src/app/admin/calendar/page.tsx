import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { BLOCKING_RESERVATION_STATUSES } from "@/lib/reservation-state-machine";

export const metadata: Metadata = { title: "Fleet Calendar", robots: { index: false } };
export const revalidate = 0;

const DAYS = 21;

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function sameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

export default async function AdminCalendarPage() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeEnd = addDays(today, DAYS);

  const [vehicles, reservations, blocks] = await Promise.all([
    prisma.vehicle.findMany({ where: { status: { not: "RETIRED" } }, orderBy: { make: "asc" } }),
    prisma.reservation.findMany({
      where: { status: { in: BLOCKING_RESERVATION_STATUSES }, pickupAt: { lt: rangeEnd }, returnAt: { gt: today } },
    }),
    prisma.vehicleBlock.findMany({ where: { startAt: { lt: rangeEnd }, endAt: { gt: today } } }),
  ]);

  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i));

  function cellStatus(vehicleId: string, day: Date) {
    const dayEnd = addDays(day, 1);
    const reservation = reservations.find((r) => r.vehicleId === vehicleId && r.pickupAt < dayEnd && r.returnAt > day);
    if (reservation) return reservation.status === "ACTIVE" ? "active" : "reserved";
    const block = blocks.find((b) => b.vehicleId === vehicleId && b.startAt < dayEnd && b.endAt > day);
    if (block) return block.reason === "MAINTENANCE" ? "maintenance" : "unavailable";
    return "available";
  }

  const statusStyles: Record<string, string> = {
    available: "bg-emerald-500/15 border-emerald-500/20",
    reserved: "bg-amber-500/20 border-amber-500/30",
    active: "bg-gold/25 border-gold/40",
    maintenance: "bg-red-500/15 border-red-500/25",
    unavailable: "bg-white/10 border-white/15",
  };

  return (
    <div>
      <h1 className="font-display text-3xl font-bold text-white">Fleet Calendar</h1>
      <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted">
        {Object.entries({
          available: "Available",
          reserved: "Reserved",
          active: "Active Rental",
          maintenance: "Maintenance",
          unavailable: "Unavailable",
        }).map(([key, label]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span className={cn("h-3 w-3 rounded-sm border", statusStyles[key])} /> {label}
          </span>
        ))}
      </div>

      <div role="region" aria-label="Reservation calendar" tabIndex={0} className="mt-6 overflow-x-auto rounded-xl border border-white/10">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-surface p-2 text-left text-white">Vehicle</th>
              {days.map((d) => (
                <th key={d.toISOString()} className="min-w-[34px] p-1 text-center font-normal text-muted">
                  {d.getDate()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td className="sticky left-0 z-10 whitespace-nowrap bg-surface p-2 text-white">
                  {v.year} {v.make} {v.model}
                </td>
                {days.map((d) => (
                  <td key={d.toISOString()} className="p-0.5">
                    <div
                      title={`${d.toLocaleDateString()} — ${cellStatus(v.id, d)}`}
                      className={cn("h-6 w-8 rounded border", statusStyles[cellStatus(v.id, d)], sameDay(d, today) && "ring-1 ring-gold")}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
