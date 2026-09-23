import { handoffSchema } from "@/lib/validations/host-mobile";
import { prisma } from "@/lib/prisma";
import type { DomainDatabase } from "@/lib/domain-transaction";
import { withReservationLock } from "@/lib/financial-locks";
import { tripParticipant } from "@/lib/trip-experience";
import { MarketplaceError } from "@/lib/marketplace";

export async function recordIdentityHandoff(userId: string, reservationId: string, input: unknown, db: DomainDatabase = prisma) {
  const data = handoffSchema.parse(input);
  return withReservationLock(reservationId, async tx => {
    // Reservation before user, matching trip/case writes; employee removal also
    // locks User, so a revoked membership cannot commit a later attestation.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
    const { reservation, role } = await tripParticipant(tx, userId, reservationId);
    if (role !== "HOST") throw new MarketplaceError("Only the assigned host may verify identity.", 403);
    if (!["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"].includes(reservation.status)) throw new MarketplaceError("Pickup phase is closed.", 409);
    const verified = data.licenseMatchesUpload && data.physicalLicenseUnexpired && data.selfieMatchesCustomer;
    if (verified) {
      const docs = await tx.driverDocument.findMany({ where: { reservationId, userId: reservation.customerId, deletedAt: null, malwareScanStatus: "CLEAN", OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: new Date() } }] }, select: { type: true } });
      if (!["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"].every(type => docs.some(d => d.type === type))) throw new MarketplaceError("Clean identity evidence is required before comparison.", 409);
    }
    const values = { ...data, verifiedByHostId: userId, verifiedAt: verified ? new Date() : null };
    const handoff = await tx.identityHandoffVerification.upsert({ where: { reservationId }, create: { reservationId, ...values }, update: values });
    await tx.tripEvent.create({ data: { reservationId, actorId: userId, type: "IDENTITY_HANDOFF_RECORDED", metadata: { verified } } });
    return { id: handoff.id, verified };
  }, db);
}
