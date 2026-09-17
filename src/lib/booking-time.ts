import { Temporal } from "@js-temporal/polyfill";
export const DEFAULT_BOOKING_TIMEZONE = "America/Chicago";
export function bookingLocal(instant: Date | string, zone: string) {
  return Temporal.Instant.from(new Date(instant).toISOString()).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
// Offset-bearing input is already an instant. Wall-clock input must resolve
// uniquely in the explicit business zone; neither gaps nor folds are guessed.
export function bookingInstant(value: string, zone: string): Date {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    const explicit = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Temporal.Instant.from(value) : null;
    const local = explicit ? explicit.toZonedDateTimeISO(zone).toPlainDateTime() : Temporal.PlainDateTime.from(value, { overflow: "reject" });
    if (local.second || local.millisecond || local.microsecond || local.nanosecond) throw new Error("Whole minutes required");
    return new Date(local.toZonedDateTime(zone, { disambiguation: "reject" }).epochMilliseconds);
  } catch { throw new Error("Choose a valid, unambiguous local date/time in " + zone + ". Daylight-saving gaps and repeated times cannot be booked."); }
}

export function bookingDays(pickupAt: Date, returnAt: Date, zone = DEFAULT_BOOKING_TIMEZONE) {
  const start = Temporal.PlainDate.from(bookingLocal(pickupAt, zone).slice(0,10));
  const end = Temporal.PlainDate.from(bookingLocal(returnAt, zone).slice(0,10));
  return Math.max(1, start.until(end).days);
}
