import type { Prisma } from "@prisma/client";

export class ReturnFinancialReviewError extends Error {
  constructor() { super("Resolve financial review and establish settlement authority before completing the return."); }
}

// Call under the shared reservation/vehicle guard. VERIFIED evidence is not a
// resolved case. Only the case-resolution workflow may exclude its own verified
// case while atomically recording the authorized settlement decision.
export async function assertSettledReturnEvidence(tx: Prisma.TransactionClient, id: string, verifiedCaseId?: string) {
  const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { payments: true, refunds: true, deposit: true } });
  const cases = await tx.financialCase.count({ where: { reservationId: id, status: { not: "RESOLVED" }, ...(verifiedCaseId ? { id: { not: verifiedCaseId } } : {}) } });
  const reconciliations = await tx.paymentReconciliation.count({ where: { OR: [{ reservationId: id }, { paymentId: { in: r.payments.map(p => p.id) } }], status: { in: ["OPEN", "NEEDS_MANUAL_REVIEW"] } } });
  const operations = await tx.financialOperation.findMany({ where: { reservationId: id, kind: { in: ["RENTAL", "REFUND", "DEPOSIT", "DEPOSIT_RELEASE"] } } });
  const uncertain = operations.some(op => {
    if (op.leaseToken || op.leaseExpiresAt || !["OBSERVED", "POLL"].includes(op.state)) return true;
    if (op.state === "OBSERVED") return false;
    const status = (op.result as { status?: string } | null)?.status;
    return !op.providerId || !(op.kind === "RENTAL" && status === "succeeded" || op.kind === "DEPOSIT" && status === "requires_capture");
  });
  if (cases || reconciliations || uncertain || r.refunds.some(f => f.legacyUncertain || f.status === "PENDING") || r.deposit?.legacyUncertain || (r.depositCents > 0 && !r.deposit) || !r.payments.some(p => p.type === "RENTAL" && p.status === "SUCCEEDED") || r.payments.some(p => ["PENDING", "PROCESSING"].includes(p.status))) throw new ReturnFinancialReviewError();
  return r;
}

export async function assertReturnFinancialAuthority(tx: Prisma.TransactionClient, id: string) {
  const r = await assertSettledReturnEvidence(tx, id);
  if (!["OPEN", "TERMINATED"].includes(r.financialDisposition)) throw new ReturnFinancialReviewError();
  return r;
}

// Revalidate queued releases too: reconciliation may commit after completion
// planned a release but before its worker starts. The dispatch guard calls this
// again on the pinned PostgreSQL session immediately before cancellation.
export async function assertDepositReleaseReviewClear(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { trip: true } });
  // Phase 1 separately authorizes compensation of exact superseded/expired
  // pre-trip authorizations. Preserve that recovery policy; this guard fences
  // releases arising from operational-trip completion and return settlement.
  if (!r.trip?.startedAt && !["ACTIVE", "RETURN_IN_PROGRESS", "COMPLETED", "DISPUTED", "UNDER_CLAIM_REVIEW"].includes(r.status)) return;
  await assertNoUnresolvedFinancialReview(tx, id);
}

export async function assertNoUnresolvedFinancialReview(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { payments: true, refunds: true, deposit: true } });
  const cases = await tx.financialCase.count({ where: { reservationId: id, status: { not: "RESOLVED" } } });
  const reconciliations = await tx.paymentReconciliation.count({ where: { OR: [{ reservationId: id }, { paymentId: { in: r.payments.map(p => p.id) } }], status: { in: ["OPEN", "NEEDS_MANUAL_REVIEW"] } } });
  const quarantined = await tx.financialOperation.count({ where: { reservationId: id, state: { in: ["REVIEW", "DEAD_LETTER"] } } });
  if (r.financialDisposition === "REVIEW" || cases || reconciliations || quarantined || r.refunds.some(f => f.legacyUncertain) || r.deposit?.legacyUncertain) throw new ReturnFinancialReviewError();
}
