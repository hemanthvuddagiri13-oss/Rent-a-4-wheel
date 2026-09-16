import type { ReservationStatus } from "@prisma/client";

const CUSTOMER_CANCELLABLE_STATUSES: ReservationStatus[] = ["PENDING", "CONFIRMED"];

/**
 * A customer may self-cancel a reservation only while it hasn't started
 * and hasn't already reached a terminal state. Anything else (already
 * active/completed/cancelled) must go through staff in /admin.
 */
export function canCustomerCancel(
  reservation: { status: ReservationStatus; pickupAt: Date },
  now: Date = new Date()
): { allowed: boolean; reason?: string } {
  if (!CUSTOMER_CANCELLABLE_STATUSES.includes(reservation.status)) {
    return { allowed: false, reason: "This reservation can no longer be cancelled online." };
  }
  if (reservation.pickupAt <= now) {
    return { allowed: false, reason: "This reservation has already started and cannot be self-cancelled." };
  }
  return { allowed: true };
}
