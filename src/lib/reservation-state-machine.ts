import type { Prisma, ReservationStatus } from "@prisma/client";

/**
 * The complete booking lifecycle. Every legal transition is listed
 * explicitly — anything not listed here is illegal and must be rejected,
 * server-side, with no exceptions for "just this once" admin overrides.
 * (Staff overrides use `force: true` on `transitionReservation`, which is a
 * separate, audited escape hatch — it does not change what this table says
 * is legal for the ordinary customer/host-driven flow.)
 */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  DRAFT: ["CHECKOUT_HOLD", "EXPIRED", "CANCELLED_BY_CUSTOMER"],
  CHECKOUT_HOLD: ["AWAITING_PAYMENT", "EXPIRED", "CANCELLED_BY_CUSTOMER"],
  AWAITING_PAYMENT: ["CONFIRMED", "PAYMENT_FAILED", "EXPIRED", "CANCELLED_BY_CUSTOMER"],
  PAYMENT_FAILED: ["AWAITING_PAYMENT", "EXPIRED", "CANCELLED_BY_CUSTOMER"],
  CONFIRMED: ["DOCUMENTS_REQUIRED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"],
  DOCUMENTS_REQUIRED: ["READY_FOR_CHECK_IN", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"],
  READY_FOR_CHECK_IN: ["CHECK_IN_PROGRESS", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"],
  CHECK_IN_PROGRESS: ["READY_TO_START", "READY_FOR_CHECK_IN", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"],
  READY_TO_START: ["ACTIVE", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"],
  ACTIVE: ["RETURN_IN_PROGRESS", "DISPUTED"],
  RETURN_IN_PROGRESS: ["COMPLETED", "DISPUTED"],
  DISPUTED: ["UNDER_CLAIM_REVIEW", "COMPLETED"],
  UNDER_CLAIM_REVIEW: ["COMPLETED"],
  COMPLETED: ["DISPUTED", "UNDER_CLAIM_REVIEW"],
  CANCELLED_BY_CUSTOMER: [],
  CANCELLED_BY_HOST: [],
  EXPIRED: [],
};

// Reservation statuses that occupy the vehicle for its [pickupAt, returnAt)
// range and must therefore block every other customer from booking an
// overlapping slot. CHECKOUT_HOLD/AWAITING_PAYMENT are included here (the
// whole point of a hold) but are also `expiresAt`-bounded — see
// `isVehicleAvailable`, which filters expired holds out in real time even
// before the cleanup job has run. CONFIRMED-and-later statuses are also
// enforced at the database level by the `reservation_no_overlap_when_blocking`
// exclusion constraint (see the phase1 migration).
export const BLOCKING_RESERVATION_STATUSES: ReservationStatus[] = [
  "CHECKOUT_HOLD",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "DOCUMENTS_REQUIRED",
  "READY_FOR_CHECK_IN",
  "CHECK_IN_PROGRESS",
  "READY_TO_START",
  "ACTIVE",
  "RETURN_IN_PROGRESS",
  "DISPUTED",
  "UNDER_CLAIM_REVIEW",
];

// Statuses with no `expiresAt` deadline — once here, only an explicit
// transition (cancellation, completion, dispute) moves the reservation on.
export const NON_EXPIRING_STATUSES: ReservationStatus[] = BLOCKING_RESERVATION_STATUSES.filter(
  (s) => s !== "CHECKOUT_HOLD" && s !== "AWAITING_PAYMENT"
);

export class IllegalTransitionError extends Error {
  constructor(from: ReservationStatus, to: ReservationStatus) {
    super(`Illegal reservation state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class StaleReservationStateError extends Error {
  constructor(id: string, expectedFrom: ReservationStatus) {
    super(`Reservation ${id} was not in status ${expectedFrom} when the transition was attempted (concurrent update).`);
    this.name = "StaleReservationStateError";
  }
}

export function isTransitionAllowed(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionAllowed(from: ReservationStatus, to: ReservationStatus): void {
  if (!isTransitionAllowed(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/**
 * Atomically moves a reservation from `from` to `to` using a
 * compare-and-swap update (`updateMany` guarded by the expected current
 * status) so two concurrent requests can never both "win" the same
 * transition. Rejects the transition outright if it isn't legal per
 * `RESERVATION_TRANSITIONS`, unless `force` is set (an audited staff
 * override — callers must still record who/why separately).
 */
export async function transitionReservation(
  tx: Prisma.TransactionClient,
  params: {
    id: string;
    from: ReservationStatus;
    to: ReservationStatus;
    force?: boolean;
    data?: Prisma.ReservationUpdateInput;
  }
): Promise<void> {
  const { id, from, to, force = false, data = {} } = params;
  if (!force) {
    assertTransitionAllowed(from, to);
  }

  const result = await tx.reservation.updateMany({
    where: { id, status: from },
    data: { ...data, status: to },
  });

  if (result.count !== 1) {
    throw new StaleReservationStateError(id, from);
  }
}
