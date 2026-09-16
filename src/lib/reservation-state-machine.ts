import type { Prisma, ReservationStatus } from "@prisma/client";
import { lockReservation, assertFinancialTripStart } from "@/lib/financial-locks";

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

// The only two statuses whose "does this block the vehicle" answer may
// depend on `expiresAt` — a checkout hold or an awaiting-payment window
// that has run out stops blocking in real time, before any cleanup job
// gets to it. See `isVehicleAvailable`.
export const TRANSIENT_HOLD_STATUSES: ReservationStatus[] = ["CHECKOUT_HOLD", "AWAITING_PAYMENT"];

// Every other status that occupies the vehicle blocks unconditionally,
// regardless of whatever `expiresAt` value happens to be sitting on the
// row (stale or otherwise) — a confirmed/active reservation, or one stuck
// in PAYMENT_FAILED while we still hold the customer's rental payment
// (see src/lib/payment-reconciliation.ts — that status is only ever
// released by an explicit transition, never by expiresAt comparison),
// must never silently become "available" just because an old checkout
// deadline passed. Also enforced at the database level for CONFIRMED and
// later by the `reservation_no_overlap_when_blocking` exclusion
// constraint (see the phase1 migration).
export const DURABLE_BLOCKING_STATUSES: ReservationStatus[] = [
  "CONFIRMED",
  "DOCUMENTS_REQUIRED",
  "READY_FOR_CHECK_IN",
  "CHECK_IN_PROGRESS",
  "READY_TO_START",
  "ACTIVE",
  "RETURN_IN_PROGRESS",
  "DISPUTED",
  "UNDER_CLAIM_REVIEW",
  "PAYMENT_FAILED",
];

export const BLOCKING_RESERVATION_STATUSES: ReservationStatus[] = [...TRANSIENT_HOLD_STATUSES, ...DURABLE_BLOCKING_STATUSES];

// Statuses with no `expiresAt` deadline — once here, only an explicit
// transition (cancellation, completion, dispute) moves the reservation on.
// (PAYMENT_FAILED is deliberately excluded: it DOES carry an `expiresAt`,
// repurposed as the customer's recovery deadline before an automatic
// refund — see src/lib/payment-reconciliation.ts — but that deadline is
// read by the cleanup job, never by the availability query, per
// `DURABLE_BLOCKING_STATUSES` above.)
export const NON_EXPIRING_STATUSES: ReservationStatus[] = DURABLE_BLOCKING_STATUSES.filter((s) => s !== "PAYMENT_FAILED");

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
 *
 * Defensively clears `expiresAt` whenever the destination status is a
 * `DURABLE_BLOCKING_STATUSES` member other than `PAYMENT_FAILED` (which
 * sets its own recovery-deadline `expiresAt`) — a caller forgetting to
 * pass `expiresAt: null` on confirmation must never leave a stale
 * checkout deadline sitting on an otherwise-durable row. Pass an explicit
 * `expiresAt` in `data` to override this (used by the PAYMENT_FAILED
 * recovery-window transition).
 */
export async function transitionReservation(
  tx: Prisma.TransactionClient,
  params: {
    id: string;
    from: ReservationStatus;
    to: ReservationStatus;
    force?: boolean;
    data?: Prisma.ReservationUpdateInput;
    // Extra compare-and-swap conditions beyond `id`/`status` — e.g. the
    // background cleanup job additionally requires `expiresAt: { lt: now }`
    // at WRITE time (not just at the read that decided this row looked
    // stale), so a hold that a customer refreshed a moment earlier (same
    // status, new expiresAt) can never be expired out from under them.
    whereExtra?: Prisma.ReservationWhereInput;
  }
): Promise<void> {
  const { id, from, to, force = false, data = {}, whereExtra = {} } = params;
  const current = await lockReservation(tx, id);
  if (!force) assertTransitionAllowed(from, to);
  if (to === "ACTIVE") await assertFinancialTripStart(tx, id);
  if ((current.financialDisposition !== "OPEN" || ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"].includes(current.status)) &&
      !["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST", "EXPIRED", "COMPLETED"].includes(to)) {
    throw new Error("Financially terminated reservation cannot reopen");
  }
  if (["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"].includes(to)) {
    data.financialDisposition = ["CHECKOUT_HOLD", "AWAITING_PAYMENT", "PAYMENT_FAILED"].includes(from) ? "REFUND_REQUIRED" : "TERMINATED";
  }

  const shouldAutoClearExpiry =
    !("expiresAt" in data) && DURABLE_BLOCKING_STATUSES.includes(to) && to !== "PAYMENT_FAILED";

  const result = await tx.reservation.updateMany({
    where: { id, status: from, ...whereExtra },
    data: { ...data, status: to, ...(shouldAutoClearExpiry ? { expiresAt: null } : {}) },
  });

  if (result.count !== 1) {
    throw new StaleReservationStateError(id, from);
  }
}
