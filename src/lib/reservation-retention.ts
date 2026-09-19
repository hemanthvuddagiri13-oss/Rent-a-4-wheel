import { Prisma } from "@prisma/client";

// One predicate for candidate selection AND locked revalidation. Financial and
// signed-agreement evidence has no automatic release policy; keep it indefinitely.
// Reservation legal/security holds are represented by its collaboration records.
export function reservationHeldSql(id: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "Reservation" r WHERE r.id=${id} AND (
    r."financialDisposition"='REVIEW'
    OR EXISTS (SELECT 1 FROM "LedgerJournal" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "FinanceDocument" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "FinanceIssue" x WHERE x."reservationId"=r.id AND x.status<>'RESOLVED')
    OR EXISTS (SELECT 1 FROM "ProviderDispute" x WHERE x."reservationId"=r.id AND x.active)
    OR EXISTS (SELECT 1 FROM "FinancialOperation" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "FinancialCase" x WHERE x."reservationId"=r.id AND x.status<>'RESOLVED')
    OR EXISTS (SELECT 1 FROM "PaymentReconciliation" x WHERE x."reservationId"=r.id AND x.status IN ('OPEN','NEEDS_MANUAL_REVIEW'))
    OR EXISTS (SELECT 1 FROM "Payment" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "Refund" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "SecurityDeposit" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "AgreementAcceptance" x WHERE x."reservationId"=r.id)
    OR EXISTS (SELECT 1 FROM "ServiceCase" x WHERE x."reservationId"=r.id AND (x."legalHold" OR x."securityHold" OR x.state<>'CLOSED' OR x."retainUntil">now()))
    OR EXISTS (SELECT 1 FROM "Conversation" x WHERE x."reservationId"=r.id AND x."legalHold")
    OR EXISTS (SELECT 1 FROM "TripReview" x WHERE x."reservationId"=r.id AND x."legalHold")
    OR EXISTS (SELECT 1 FROM "CollaborationFile" f LEFT JOIN "Conversation" c ON c.id=f."conversationId" LEFT JOIN "ServiceCase" s ON s.id=f."caseId" WHERE COALESCE(c."reservationId",s."reservationId")=r.id AND f."legalHold" AND f."deletedAt" IS NULL)
    OR EXISTS (SELECT 1 FROM "PrivacyDeletion" p WHERE p.state='RETAINED_LEGAL_REVIEW' AND (
      p."userId"=r."customerId"
      OR EXISTS (SELECT 1 FROM "Vehicle" v JOIN "HostProfile" h ON h.id=v."hostId" WHERE v.id=r."vehicleId" AND h."userId"=p."userId")
      OR EXISTS (SELECT 1 FROM "TripReview" t WHERE t."reservationId"=r.id AND t."reviewerId"=p."userId")
    ))
  ))`;
}

// Caller must acquire lockReservation before authorizing deletion.
export async function reservationEvidenceHeld(tx: Prisma.TransactionClient, id: string | null) {
  if (!id) return false;
  const [result] = await tx.$queryRaw<Array<{held:boolean}>>(Prisma.sql`SELECT ${reservationHeldSql(Prisma.sql`${id}`)} AS held`);
  return result.held;
}

// Unknown notification targets are kept: retention must never guess provenance.
export const noticeReservationSql = Prisma.sql`CASE n."resourceType"
  WHEN 'RESERVATION' THEN n."resourceId"
  WHEN 'CASE' THEN (SELECT "reservationId" FROM "ServiceCase" WHERE id=n."resourceId")
  WHEN 'CONVERSATION' THEN (SELECT "reservationId" FROM "Conversation" WHERE id=n."resourceId")
  WHEN 'REVIEW' THEN (SELECT "reservationId" FROM "TripReview" WHERE id=n."resourceId")
  ELSE NULL END`;
