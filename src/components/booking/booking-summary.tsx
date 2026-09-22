import { formatCurrency } from "@/lib/utils";
import type { BookingState, BookingVehicle } from "@/components/booking/types";

// Booking date/time fields are already local to the booking's own timezone
// (see the "All booking times: {bookingTimezone}" note beside this
// summary) — format with timeZone:"UTC" so the viewer's browser never
// re-shifts an already-local value into its own timezone.
function formatBookingMoment(date: string, time: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return `${date} ${time}`;
  const instant = new Date(Date.UTC(y, m - 1, d, hh, mm));
  if (!Number.isFinite(instant.getTime())) return "Choose valid dates and times";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(instant);
}

/**
 * Persistent trip context visible on every step, not only review/payment.
 * Only the server-computed breakdown's total is shown as a price — no
 * client-estimated figure is invented before that response exists.
 */
export function BookingSummary({ vehicle, state }: { vehicle: BookingVehicle; state: BookingState }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/10 bg-card p-4 sm:p-5">
      <div className="min-w-0">
        <p className="break-words font-medium text-white">
          {vehicle.year} {vehicle.make} {vehicle.model}
          {vehicle.trim ? ` ${vehicle.trim}` : ""}
        </p>
        <p className="mt-1 break-words text-sm text-silver">
          {formatBookingMoment(state.pickupDate, state.pickupTime)} — {formatBookingMoment(state.returnDate, state.returnTime)}
        </p>
        {state.confirmationNumber && <p className="mt-1 text-xs text-muted">Confirmation {state.confirmationNumber}</p>}
      </div>
      {state.breakdown && (
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted">{state.checkoutComplete ? "Booking total" : "Last quoted total"}</p>
          <p className="text-lg font-semibold text-gold-bright">{formatCurrency(state.breakdown.totalCents)}</p>
        </div>
      )}
    </div>
  );
}
