import type { Prisma } from "@prisma/client";
import { fingerprint } from "@/lib/financial-operations";
import { lockReservation } from "@/lib/financial-locks";

// Version 1 omitted the timezone. Version 2 preserves the Batch 1D hash.
// A representation-only upgrade preserves revision, prices and UTC instants.
export async function upgradeBookingFingerprint(tx: Prisma.TransactionClient, id: string) {
  await lockReservation(tx, id);
  const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { extras: true, coupon: true } });
  if (r.bookingFingerprintVersion >= 2 || r.status !== "CHECKOUT_HOLD" || r.checkoutFingerprint) return;
  if (r.financialDisposition !== "OPEN" || await tx.payment.count({ where: { reservationId: id } }) || await tx.financialOperation.count({ where: { reservationId: id, kind: "RENTAL" } })) throw new Error("Legacy checkout has financial activity; review required");
  const drafts = await tx.bookingDraft.findMany({ where: { reservationId: id } });
  const draft = drafts[0];
  if (drafts.length !== 1 || draft.customerId !== r.customerId || draft.vehicleId !== r.vehicleId || draft.revision < 1 || draft.fingerprint !== r.bookingFingerprint) throw new Error("Ambiguous legacy booking draft");
  if (!r.bookingTimezone || r.returnAt <= r.pickupAt || r.extras.some(e => e.quantity !== 1) || (r.couponId && !r.coupon)) throw new Error("Incomplete legacy booking tuple");
  const bookingTimezone = new Intl.DateTimeFormat("en", { timeZone: r.bookingTimezone }).resolvedOptions().timeZone;
  const tuple = { customerId: r.customerId, vehicleId: r.vehicleId, pickupAt: r.pickupAt, returnAt: r.returnAt, extraIds: r.extras.map(e => e.extraId).sort(), couponCode: r.coupon?.code.trim().toUpperCase() ?? "" };
  const upgraded = fingerprint({ ...tuple, bookingTimezone });
  if (!r.bookingFingerprint || ![fingerprint(tuple), fingerprint({ ...tuple, bookingTimezone: r.bookingTimezone })].includes(r.bookingFingerprint)) throw new Error("Legacy booking fingerprint does not match persisted selections");
  await tx.reservation.update({ where: { id }, data: { bookingTimezone, bookingFingerprint: upgraded, bookingFingerprintVersion: 2 } });
  await tx.bookingDraft.update({ where: { id: draft.id }, data: { fingerprint: upgraded, fingerprintVersion: 2 } });
}
