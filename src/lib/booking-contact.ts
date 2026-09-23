import type { Prisma } from "@prisma/client";

/** Phone-only identities must link a verified deliverable email before booking.
 * Historical accounts keep their existing gates; no contact field becomes a login. */
export async function hasVerifiedBookingContact(tx: Prisma.TransactionClient, userId: string, driverEmail?: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true, phoneIdentity: { select: { userId: true } } } });
  if (!user?.phoneIdentity) return true;
  return Boolean(user.emailVerified && !user.email.endsWith("@phone.identity.invalid") && (!driverEmail || driverEmail.trim().toLowerCase() === user.email));
}
