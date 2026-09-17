import { withReservationLock } from "@/lib/financial-locks";
import { quarantineOperation } from "@/lib/financial-cases";
import { json } from "@/lib/financial-operations";
import { assertDepositReleaseReviewClear } from "@/lib/return-financial-authority";

export async function checkDepositReleaseOwnership(operationId: string, reservationId: string) {
  return withReservationLock(reservationId, async tx => {
    try { await assertDepositReleaseReviewClear(tx, reservationId); } catch { return false; }
    const op = await tx.financialOperation.findUniqueOrThrow({ where: { id: operationId } });
    if (op.kind !== "DEPOSIT_RELEASE" || op.reservationId !== reservationId) throw new Error("Release operation mismatch");
    const target = (op.payload as { intentId?: string }).intentId;
    const ownership = target ? await tx.providerObjectOwnership.findUnique({ where: { providerId: target } }) : null;
    const originals = target ? await tx.financialOperation.findMany({ where: { kind: "DEPOSIT", reservationId, providerId: target }, select: { id: true, generation: true } }) : [];
    const deposit = target ? await tx.securityDeposit.findFirst({ where: { reservationId, stripePaymentIntentId: target }, select: { id: true, generation: true } }) : null;
    const valid = target && ownership?.kind === "DEPOSIT" && ownership.reservationId === reservationId && !ownership.refundId
      && originals.length <= 1 && (originals.length === 1 || deposit)
      && (!ownership.operationId || originals[0]?.id === ownership.operationId)
      && (!ownership.depositId || !deposit || ownership.depositId === deposit.id);
    if (valid) return !["REVIEW", "DEAD_LETTER"].includes(op.state);
    const reason = "DEPOSIT_RELEASE_OWNERSHIP_REQUIRES_REVIEW";
    const firstQuarantine = op.state !== "REVIEW" || op.lastError !== reason;
    const priorCase = firstQuarantine ? await tx.financialCase.findUnique({ where: { sourceKey: "operation:" + op.id } }) : null;
    await tx.financialOperation.update({ where: { id: op.id }, data: { state: "REVIEW", nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, lastError: reason } });
    await quarantineOperation(tx, op.id, reason);
    const dispatches = await tx.financialDispatch.findMany({ where: { operationId: op.id }, select: { phase: true, providerId: true, createdAt: true } });
    const evidence = json({ intentId: target ?? null, generation: op.generation, ownership, originalAuthorizations: originals, deposit, reason, dispatches });
    const c = await tx.financialCase.update({ where: { sourceKey: "operation:" + op.id }, data: { providerId: target ?? op.providerId, evidence, reason, ...(firstQuarantine ? { status: "OPEN", resolution: null, resolvedAt: null } : {}) } });
    if (firstQuarantine) await tx.auditLog.create({ data: { action: "financial-case.release-ownership-quarantined", entityType: "FinancialCase", entityId: c.id, metadata: json({ evidence, previousState: op.state, previousError: op.lastError, previousCaseReason: priorCase?.reason ?? null }) } });
    return false;
  });
}
