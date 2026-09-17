import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { withReservationLock } from "@/lib/financial-locks";
import { prepareOperation, json } from "@/lib/financial-operations";
import { applyRefundObservation, reserveRefund } from "@/lib/refund-operations";
import { syncDepositIntent } from "@/lib/deposit-authorization";
import { planAllDepositReleases } from "@/lib/deposit-release-plan";
import { PRE_TRIP_STATES } from "@/lib/financial-projection";
import { linkLegacyRentalEvidence } from "@/lib/legacy-rental-evidence";
import { assertSettledReturnEvidence } from "@/lib/return-financial-authority";

type Action = "ADOPT" | "CONFIRM_FAILURE" | "AUTHORIZE_SETTLEMENT" | "RELEASE_INVENTORY" | "ESCALATE" | "ASSIGN";
export async function resolveFinancialCase(actor: { id: string; role: string }, input: { caseId: string; action: Action; reason: string; providerId?: string; assigneeId?: string }) {
  // Recheck database privileges: never trust form fields or stale session roles.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!user.isActive || !["ADMIN", "SUPER_ADMIN"].includes(user.role)) throw new Error("Forbidden");
  if (input.reason.trim().length < 10) throw new Error("A specific reason of at least 10 characters is required");
  if (["AUTHORIZE_SETTLEMENT", "RELEASE_INVENTORY"].includes(input.action) && user.role !== "SUPER_ADMIN") throw new Error("Super administrator required");
  const c = await prisma.financialCase.findUniqueOrThrow({ where: { id: input.caseId } });
  const providerId = input.providerId?.trim() || c.providerId;
  let refund: Awaited<ReturnType<NonNullable<typeof stripe>["refunds"]["retrieve"]>> | undefined;
  let intent: Awaited<ReturnType<NonNullable<typeof stripe>["paymentIntents"]["retrieve"]>> | undefined;
  if (["ADOPT", "CONFIRM_FAILURE"].includes(input.action)) {
    if (!stripe || !providerId) throw new Error("Verified Stripe identity is required; absence is not proof of failure");
    if (c.kind === "REFUND") refund = await stripe.refunds.retrieve(providerId);
    else intent = await stripe.paymentIntents.retrieve(providerId);
  }
  await withReservationLock(c.reservationId, async tx => {
    const authorizedActor = await tx.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!authorizedActor.isActive || !["ADMIN", "SUPER_ADMIN"].includes(authorizedActor.role) || (["AUTHORIZE_SETTLEMENT", "RELEASE_INVENTORY"].includes(input.action) && authorizedActor.role !== "SUPER_ADMIN")) throw new Error("Forbidden");
    let current = await tx.financialCase.findUniqueOrThrow({ where: { id: input.caseId } });
    let c = current;
    if (current.status === "RESOLVED") throw new Error("Case already resolved");
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: c.reservationId }, include: { deposit: true, payments: true, refunds: true, trip: true } });
    let evidence: Prisma.InputJsonValue | null = current.evidence;
    if (refund) {
      const f = c.refundId ? await tx.refund.findUniqueOrThrow({ where: { id: c.refundId } }) : await tx.refund.findUniqueOrThrow({ where: { idempotencyKey: c.originalKey! } });
      const p = r.payments.find(p => p.id === f.paymentId);
      const intentId = typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
      if (!p || intentId !== p.stripePaymentIntentId || refund.amount !== f.amountCents || refund.currency !== p.currency || (f.stripeRefundId && f.stripeRefundId !== refund.id)) throw new Error("Provider refund identity or amount mismatch");
      if (input.action === "CONFIRM_FAILURE" && !["failed", "canceled"].includes(refund.status ?? "")) throw new Error("Provider has not confirmed failure");
      const occupied = await tx.refund.findUnique({ where: { stripeRefundId: refund.id } });
      if (occupied && occupied.id !== f.id) throw new Error("Provider identity already belongs to another refund");
      const op = await prepareOperation(tx, { key: f.idempotencyKey, kind: "REFUND", reservationId: r.id, payload: { refundId: f.id, paymentIntentId: p.stripePaymentIntentId, amount: f.amountCents } });
      await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: refund.id, state: "RETRY", nextAttemptAt: new Date(), consecutiveFailures: 0, leaseToken: null, leaseExpiresAt: null } });
      // Keep the reserved amount until observation commits; this transaction
      // already durably binds the verified identity for crash recovery.
      await tx.refund.update({ where: { id: f.id }, data: { stripeRefundId: refund.id, status: "PENDING", legacyUncertain: false } });
      evidence = json({ providerId: refund.id, status: refund.status, amount: refund.amount, paymentIntentId: intentId });
    }
    if (intent) {
      if (intent.id !== providerId) throw new Error("Provider returned a different identity");
      if (c.kind === "RENTAL" && c.reason === "LEGACY_RESERVATION_REVIEW" && (!c.paymentId || !c.operationId)) {
        c = current = await linkLegacyRentalEvidence(tx, c, intent);
      }
      if ((current.currency !== null && intent.currency !== current.currency) || (current.amountCents !== null && intent.amount !== current.amountCents)) throw new Error("Provider amount/currency mismatch");
      const owner = await tx.user.findUniqueOrThrow({ where: { id: r.customerId } });
      const customer = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
      if (!owner.stripeCustomerId || customer !== owner.stripeCustomerId) throw new Error("Provider customer mismatch");
      if (intent.metadata.reservationId !== r.id) throw new Error("Provider reservation evidence missing");
      if (input.action === "CONFIRM_FAILURE" && intent.status !== "canceled") throw new Error("Only provider-confirmed cancellation proves no future charge");
      let op = c.operationId ? await tx.financialOperation.findUniqueOrThrow({ where: { id: c.operationId } }) : null;
      if (op && (op.kind !== c.kind || op.reservationId !== r.id)) throw new Error("Operation kind or reservation mismatch");
      if (op?.leaseExpiresAt && op.leaseExpiresAt > new Date()) throw new Error("Operation is actively leased; retry after observation");
      if (op?.providerId && op.providerId !== intent.id) throw new Error("Operation provider identity mismatch");
      if (!op && c.kind === "DEPOSIT") {
        const matches = await tx.financialOperation.findMany({ where: { reservationId: r.id, kind: "DEPOSIT", providerId: intent.id } });
        if (matches.length > 1) throw new Error("Conflicting provider mappings require escalation");
        if (matches.length === 1) op = matches[0];
      }
      const originalAuthorization = c.kind === "DEPOSIT_RELEASE" && (op?.payload as { intentId?: string } | undefined)?.intentId === intent.id
        ? await tx.financialOperation.findFirst({ where: { reservationId: r.id, kind: "DEPOSIT", providerId: intent.id } }) : op;
      const terms = originalAuthorization?.payload as { amount?: number; currency?: string; customer?: string; metadata?: Record<string, string> } | undefined;
      if ((terms?.amount !== undefined && terms.amount !== intent.amount) || (terms?.currency && terms.currency !== intent.currency) || (terms?.customer && terms.customer !== customer)) throw new Error("Original operation terms mismatch");
      if (terms?.metadata && Object.entries(terms.metadata).some(([key, value]) => intent!.metadata[key] !== value)) throw new Error("Original provider metadata mismatch");
      if (current.amountCents === null || current.currency === null) {
        // Missing records may be investigated using an already bound identity
        // and exact original provider lineage; reservation metadata alone fails.
        if (!originalAuthorization || originalAuthorization.providerId !== intent.id || intent.metadata.operationKey !== originalAuthorization.key || !Number.isSafeInteger(intent.amount) || intent.amount <= 0 || !/^[a-z]{3}$/.test(intent.currency)) throw new Error("Amount/currency evidence unknown; escalate for investigation");
        if (["DEPOSIT", "DEPOSIT_RELEASE"].includes(c.kind) && r.deposit?.stripePaymentIntentId === intent.id && (r.deposit.amountCents !== intent.amount || r.deposit.currency !== intent.currency)) throw new Error("Linked authorization terms mismatch");
        await tx.financialCase.update({ where: { id: c.id }, data: { amountCents: intent.amount, currency: intent.currency } });
      }
      const expectedKind = c.kind === "DEPOSIT_RELEASE" ? "DEPOSIT" : c.kind;
      const ownership = await tx.providerObjectOwnership.findUnique({ where: { providerId: intent.id } });
      if (ownership && (ownership.kind !== expectedKind || ownership.reservationId !== r.id || (c.kind !== "DEPOSIT_RELEASE" && ownership.operationId && ownership.operationId !== op?.id))) throw new Error("Provider identity already belongs to another operation");
      if (c.kind === "RENTAL") {
        if (!["automatic", "automatic_async"].includes(intent.capture_method) || (intent.metadata.purpose && intent.metadata.purpose !== "rental")) throw new Error("Rental purpose/capture method mismatch");
        const payment = r.payments.find(p => p.id === c.paymentId || (op && p.idempotencyKey === op.key));
        if (!payment || payment.type !== "RENTAL" || payment.amountCents !== intent.amount || payment.currency !== intent.currency || (payment.stripePaymentIntentId && payment.stripePaymentIntentId !== intent.id) || (ownership?.paymentId && ownership.paymentId !== payment.id)) throw new Error("Original rental payment identity mismatch");
        if (intent.metadata.paymentId && intent.metadata.paymentId !== payment.id) throw new Error("Provider payment metadata mismatch");
        if (intent.metadata.operationKey && intent.metadata.operationKey !== (op?.key ?? payment.idempotencyKey)) throw new Error("Provider idempotency lineage mismatch");
        if (payment.stripePaymentIntentId !== intent.id && intent.metadata.paymentId !== payment.id && (!op || intent.metadata.operationKey !== op.key)) throw new Error("Ambiguous legacy rental identity");
      } else if (["DEPOSIT", "DEPOSIT_RELEASE"].includes(c.kind)) {
        if (intent.capture_method !== "manual" || intent.metadata.purpose !== "security_deposit") throw new Error("Deposit purpose/capture method mismatch");
        const original = c.kind === "DEPOSIT_RELEASE" ? await tx.financialOperation.findFirst({ where: { kind: "DEPOSIT", reservationId: r.id, providerId: intent.id } }) : op;
        if (intent.metadata.paymentId) throw new Error("Rental payment metadata on deposit");
        if (intent.metadata.operationKey && original?.key !== intent.metadata.operationKey) throw new Error("Provider idempotency lineage mismatch");
        const linkedLegacy = c.kind === "DEPOSIT" && !original && r.deposit?.stripePaymentIntentId === intent.id && ownership?.depositId === r.deposit.id;
        if (!linkedLegacy && (!original || (original.providerId !== intent.id && intent.metadata.operationKey !== original.key))) throw new Error("Ambiguous legacy deposit identity");
      }
      if (!op) op = await prepareOperation(tx, { key: "adopt:" + c.id, kind: c.kind, reservationId: r.id, payload: { legacy: true } });
      const superseded = c.kind === "DEPOSIT" && r.deposit?.operationId && r.deposit.operationId !== op.id && !r.deposit.legacyUncertain;
      if (superseded && input.action !== "CONFIRM_FAILURE") throw new Error("A verified current generation already owns this deposit; escalate superseded observations");
      const generation = superseded ? op.generation : c.kind === "DEPOSIT" ? (r.deposit?.generation ?? 0) + 1 : null;
      await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: intent.id, generation, result: json(intent), state: input.action === "CONFIRM_FAILURE" ? "OBSERVED" : "RETRY", nextAttemptAt: input.action === "CONFIRM_FAILURE" ? null : new Date(), consecutiveFailures: 0, leaseToken: null, leaseExpiresAt: null } });
      if (c.kind === "DEPOSIT") {
        if (!r.deposit || intent.capture_method !== "manual" || intent.metadata.purpose !== "security_deposit") throw new Error("Deposit evidence mismatch");
        const duplicate = await tx.financialOperation.count({ where: { kind: "DEPOSIT", providerId: intent.id, id: { not: op.id } } });
        if (duplicate) throw new Error("Ambiguous deposit ownership requires escalation");
        if (!superseded) {
          await tx.securityDeposit.update({ where: { id: r.deposit.id }, data: { operationId: op.id, generation: generation!, legacyUncertain: false } });
          await syncDepositIntent(r.id, intent, tx);
        }
      } else if (c.kind === "DEPOSIT_RELEASE") {
        if (intent.capture_method !== "manual" || intent.metadata.purpose !== "security_deposit" || (op.payload as { intentId?: string }).intentId !== intent.id) throw new Error("Deposit release target mismatch");
        if (intent.status === "succeeded") throw new Error("Captured deposit requires claim review; do not cancel or automatically refund");
        await syncDepositIntent(r.id, intent, tx);
      } else if (c.kind === "RENTAL") {
        const p = r.payments.find(p => p.id === c.paymentId || p.idempotencyKey === op!.key || p.stripePaymentIntentId === intent!.id);
        if (!p || (p.stripePaymentIntentId && p.stripePaymentIntentId !== intent.id)) throw new Error("Payment mapping missing or conflicting");
        await tx.payment.update({ where: { id: p.id }, data: { stripePaymentIntentId: intent.id, ...(intent.status === "succeeded" ? { status: "SUCCEEDED" } : {}) } });
      } else throw new Error("Unsupported provider operation; escalate for manual review");
      evidence = json({ providerId: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency, customer, paymentId: c.paymentId, operationId: op.id, originalKey: op.key });
    }
    if (["AUTHORIZE_SETTLEMENT", "RELEASE_INVENTORY"].includes(input.action)) {
      if (current.status !== "VERIFIED") throw new Error("Verify provider evidence before authorizing settlement");
      if (input.action === "AUTHORIZE_SETTLEMENT" && r.trip?.startedAt && ["RETURN_IN_PROGRESS", "DISPUTED", "UNDER_CLAIM_REVIEW"].includes(r.status)) {
        // Existing super-admin case workflow may authorize a no-charge return
        // only after provider verification and all other uncertainty is gone.
        // It does not complete the trip or create a release; ordinary completion
        // rechecks the resolved decision under the same lock.
        await assertSettledReturnEvidence(tx, r.id, current.id);
        await tx.reservation.update({ where: { id: r.id }, data: { financialDisposition: "TERMINATED" } });
      } else {
        if (r.trip?.startedAt || ![...PRE_TRIP_STATES, "CHECKOUT_HOLD", "AWAITING_PAYMENT", "PAYMENT_FAILED", "EXPIRED", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"].includes(r.status)) throw new Error("Operational trips cannot use pre-trip settlement");
        const unresolved = await tx.financialCase.count({ where: { reservationId: r.id, id: { not: c.id }, status: { notIn: ["RESOLVED", "VERIFIED"] } } });
        if (unresolved || r.refunds.some(f => f.legacyUncertain) || r.deposit?.legacyUncertain) throw new Error("Resolve uncertain provider outcomes before settlement");
        if (input.action === "AUTHORIZE_SETTLEMENT") {
          await tx.reservation.update({ where: { id: r.id }, data: { financialDisposition: "REFUND_REQUIRED" } });
          for (const p of r.payments.filter(p => p.type === "RENTAL" && p.status === "SUCCEEDED")) {
            const held = r.refunds.filter(f => f.paymentId === p.id && ["PENDING", "SUCCEEDED"].includes(f.status)).reduce((n,f)=>n+f.amountCents,0);
            if (p.amountCents > held) await reserveRefund(tx, { reservationId: r.id, paymentId: p.id, amountCents: p.amountCents-held, idempotencyKey: "case-settlement:"+c.id+":"+p.id, reason: input.reason, initiatedById: actor.id });
          }
        } else {
          const paid = r.payments.filter(p=>p.type==="RENTAL"&&p.status==="SUCCEEDED").reduce((n,p)=>n+p.amountCents,0);
          const returned = r.refunds.filter(f=>f.status==="SUCCEEDED" && r.payments.some(p=>p.id===f.paymentId && p.type==="RENTAL" && p.status==="SUCCEEDED")).reduce((n,f)=>n+f.amountCents,0);
          if (!paid || returned < paid || r.refunds.some(f=>f.status==="PENDING")) throw new Error("Inventory release requires durable full refund");
          await tx.reservation.update({ where: { id: r.id }, data: { status: r.status.startsWith("CANCELLED") ? r.status : "EXPIRED", financialDisposition: "TERMINATED", expiresAt: null } });
          await planAllDepositReleases(tx,r.id);
        }
      }
    }
    if (input.action === "ASSIGN") {
      const assignee = await tx.user.findUniqueOrThrow({ where: { id: input.assigneeId || actor.id } });
      if (!assignee.isActive || !["ADMIN","SUPER_ADMIN"].includes(assignee.role)) throw new Error("Invalid case assignee");
    }
    const resolved = !["ASSIGN", "ESCALATE", "ADOPT", "CONFIRM_FAILURE"].includes(input.action);
    await tx.financialCase.update({ where: { id: c.id }, data: { status: resolved ? "RESOLVED" : input.action === "ESCALATE" ? "MANUAL_REVIEW" : ["ADOPT", "CONFIRM_FAILURE"].includes(input.action) ? "VERIFIED" : current.status,
      assignedToId: input.action === "ASSIGN" ? input.assigneeId || actor.id : current.assignedToId, attempts: { increment: 1 }, providerId: providerId ?? current.providerId,
      evidence: evidence ?? undefined, resolution: resolved ? input.action : null, resolvedAt: resolved ? new Date() : null } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "financial-case."+input.action.toLowerCase(), entityType: "FinancialCase", entityId: c.id, metadata: { reason: input.reason.trim(), providerId: providerId ?? null, evidence: evidence ?? null } } });
  });
  // Identity and retry intent already committed. A crash here is recoverable.
  if (refund) {
    const f = await prisma.refund.findUniqueOrThrow({ where: { stripeRefundId: refund.id } });
    await applyRefundObservation(f.id, refund);
  }
}
