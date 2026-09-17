import { verifyAuthCode } from "@/lib/auth-code";
import { enqueueNoticeEmail } from "@/lib/notice-center";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lockReservation } from "@/lib/financial-locks";
import { MarketplaceError, marketplaceActor } from "@/lib/marketplace";
import { afterDays, audit, isOperator, participant, policy, reservationScope, safeText, type ServiceKind } from "@/lib/collaboration-access";

export const caseStates: Record<ServiceKind, Record<string, readonly string[]>> = {
  CLAIM: { REPORTED: ["EVIDENCE_SUBMITTED"], EVIDENCE_SUBMITTED: ["INITIAL_REVIEW"], INITIAL_REVIEW: ["CUSTOMER_RESPONSE"], CUSTOMER_RESPONSE: ["ESTIMATE_REVIEW"], ESTIMATE_REVIEW: ["RESPONSIBILITY_DECISION"], RESPONSIBILITY_DECISION: ["PROPOSED_SETTLEMENT"], PROPOSED_SETTLEMENT: ["ACCEPTED", "DISPUTED"], ACCEPTED: ["RESOLVED"], DISPUTED: ["RESOLVED"], RESOLVED: ["CLOSED"] },
  DISPUTE: { REPORTED: ["RESPONSE_REQUESTED"], RESPONSE_REQUESTED: ["UNDER_REVIEW"], UNDER_REVIEW: ["DECIDED"], DECIDED: ["CLOSED"] },
  INCIDENT: { REPORTED: ["TRIAGED"], TRIAGED: ["ASSISTANCE_COORDINATED"], ASSISTANCE_COORDINATED: ["RESOLVED"], RESOLVED: ["CLOSED"] },
  TICKET: { REPORTED: ["IN_PROGRESS"], IN_PROGRESS: ["WAITING_FOR_CUSTOMER", "RESOLVED"], WAITING_FOR_CUSTOMER: ["IN_PROGRESS", "RESOLVED"], RESOLVED: ["CLOSED"] },
};
export const createCaseSchema = z.object({
  kind: z.enum(["CLAIM", "DISPUTE", "INCIDENT", "TICKET"]), reservationId: z.string().optional(),
  category: z.string().min(1).max(60), title: z.string().min(3).max(160), body: z.string().min(10).max(5000), linkedCaseId: z.string().optional(),
  location: z.string().max(300).optional(), severity: z.enum(["MINOR", "MODERATE", "SEVERE"]).optional(),
  occurredAt: z.string().datetime().optional(), people: z.string().max(500).optional(), policeReport: z.string().max(100).optional(), provider: z.string().max(300).optional(), originalPhotoIds: z.array(z.string()).max(30).default([]),
});
export async function caseAccess(tx: Prisma.TransactionClient, userId: string, id: string) {
  const c = await tx.serviceCase.findUnique({ where: { id } });
  if (!c) throw new MarketplaceError("Not found.", 404);
  const r = c.reservationId ? await reservationScope(tx, c.reservationId) : null;
  const access = await participant(tx, userId, { customerId: r?.customerId ?? c.openedById, vehicleId: c.vehicleId }, c.kind as ServiceKind);
  return { c, ...access };
}
export async function createServiceCase(userId: string, input: unknown, db: PrismaClient = prisma) {
  const data = createCaseSchema.parse(input);
  const categories = {
    CLAIM: ["DAMAGE"],
    DISPUTE: ["DAMAGE", "MILEAGE", "FUEL", "LATE_RETURN", "CLEANING", "CANCELLATION", "REFUND", "UNAUTHORIZED_USE", "OTHER_CHARGES"],
    INCIDENT: ["ACCIDENT", "BREAKDOWN", "FLAT_TIRE", "LOST_KEY", "TOWING", "UNSAFE_VEHICLE", "POLICE_REPORT", "INJURY", "THEFT"],
    TICKET: ["GENERAL", "DAMAGE", "MILEAGE", "FUEL", "LATE_RETURN", "CLEANING", "CANCELLATION", "REFUND", "UNAUTHORIZED_USE", "OTHER_CHARGES"],
  };
  if (!categories[data.kind].includes(data.category)) throw new MarketplaceError("Choose a category that matches the request type.");
  return db.$transaction(async tx => {
    if (data.reservationId) await lockReservation(tx, data.reservationId);
    const r = data.reservationId ? await reservationScope(tx, data.reservationId) : null;
    if (data.kind !== "TICKET" && !r) throw new MarketplaceError("Select a reservation.");
    const access = await participant(tx, userId, { customerId: r?.customerId ?? userId, vehicleId: r?.vehicleId }, data.kind);
    if (data.kind === "CLAIM" && access.role !== "HOST" && access.role !== "OPERATOR") throw new MarketplaceError("The assigned host or claims team opens a damage claim.", 403);
    const trip = r ? await tx.trip.findUnique({ where: { reservationId: r.id } }) : null;
    if (data.kind === "CLAIM" && !trip?.startedAt) throw new MarketplaceError("Damage claims require an actual trip.", 409);
    if (data.linkedCaseId) {
      const linked = await caseAccess(tx, userId, data.linkedCaseId);
      if (linked.c.reservationId !== r?.id) throw new MarketplaceError("Related cases must concern the same reservation.");
    }
    const photos = await tx.conditionPhoto.findMany({ where: { id: { in: data.originalPhotoIds }, conditionReport: { reservationId: r?.id ?? "", acceptedAt: { not: null } } }, select: { id: true } });
    if (photos.length !== new Set(data.originalPhotoIds).size) throw new MarketplaceError("Evidence must belong to this trip.", 404);
    const p = await policy(tx), body = safeText(data.body);
    const damageKey = data.kind === "CLAIM" && !data.linkedCaseId ? createHash("sha256").update(JSON.stringify([r!.id, data.category.toLowerCase().trim(), data.location?.toLowerCase().trim() ?? ""])).digest("hex") : null;
    const safetyBlock = data.kind === "INCIDENT" && (data.severity === "SEVERE" || ["ACCIDENT", "BREAKDOWN", "UNSAFE_VEHICLE", "INJURY", "THEFT", "TOWING", "FLAT_TIRE"].includes(data.category));
    const c = await tx.serviceCase.create({ data: { kind: data.kind, reservationId: r?.id, vehicleId: r?.vehicleId, openedById: userId, linkedCaseId: data.linkedCaseId, damageKey, category: data.category, title: safeText(data.title), details: { body, openedByRole: access.role, location: data.location ?? "", severity: data.severity ?? "MINOR", occurredAt: data.occurredAt ?? new Date().toISOString(), people: data.people ?? "", policeReport: data.policeReport ?? "", provider: data.provider ?? "", originalPhotoIds: photos.map(p => p.id) }, priority: safetyBlock ? "URGENT" : "NORMAL", dueAt: new Date(Date.now() + (safetyBlock ? 0 : p.responseHours * 3600000)), retainUntil: afterDays(data.kind === "CLAIM" ? p.claimDays : data.kind === "DISPUTE" ? p.disputeDays : data.kind === "INCIDENT" ? p.incidentDays : p.ticketDays), safetyBlock } });
    await tx.serviceCaseEvent.create({ data: { caseId: c.id, actorId: userId, action: "OPEN", fromState: "", toState: "REPORTED", body, version: 0, deadlineAt: c.dueAt } });
    if (r && ["CLAIM", "DISPUTE"].includes(data.kind)) {
      // REVIEW is sticky: resolving this operational case cannot authorize money.
      await tx.reservation.update({ where: { id: r.id }, data: { financialDisposition: "REVIEW" } });
      const payment = await tx.payment.findFirst({ where: { reservationId: r.id, type: "RENTAL", status: "SUCCEEDED" }, orderBy: { createdAt: "asc" } });
      if (payment) {
        const operation = await tx.financialOperation.findFirst({ where: { reservationId: r.id, kind: "RENTAL", ...(payment.stripePaymentIntentId ? { providerId: payment.stripePaymentIntentId } : { key: payment.idempotencyKey ?? "" }) } });
        await tx.financialCase.upsert({ where: { sourceKey: `collaboration-review:${r.id}` }, create: { sourceKey: `collaboration-review:${r.id}`, reservationId: r.id, customerId: r.customerId, kind: "RENTAL", paymentId: payment.id, operationId: operation?.id, providerId: payment.stripePaymentIntentId, originalKey: payment.idempotencyKey, amountCents: payment.amountCents, currency: payment.currency, reason: "Operational claim or dispute requires separate verified financial settlement" }, update: { status: "OPEN", resolvedAt: null, resolution: null, reason: "A new operational claim or dispute requires renewed financial review" } });
      }
    }
    if (r && safetyBlock) {
      await tx.vehicle.update({ where: { id: r.vehicleId }, data: { status: "MAINTENANCE" } });
      await tx.vehicleAvailabilityConfig.upsert({ where: { vehicleId: r.vehicleId }, create: { vehicleId: r.vehicleId, isBookable: false }, update: { isBookable: false } });
      const bookings = await tx.reservation.findMany({ where: { vehicleId: r.vehicleId, returnAt: { gt: new Date() }, status: { notIn: ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST", "COMPLETED", "EXPIRED"] } }, select: { id: true } });
      for (const booking of bookings) await tx.tripEvent.create({ data: { reservationId: booking.id, actorId: userId, type: "SAFETY_OPERATOR_REVIEW", metadata: { incidentId: c.id } } });
    }
    await notifyCase(tx, c.id, userId);
    await audit(tx, userId, `service.${data.kind.toLowerCase()}.open`, "ServiceCase", c.id);
    return { id: c.id };
  }, { timeout: 15000 });
}
async function notifyCase(tx: Prisma.TransactionClient, id: string, actorId: string) {
  const c = await tx.serviceCase.findUniqueOrThrow({ where: { id } });
  const r = c.reservationId ? await tx.reservation.findUnique({ where: { id: c.reservationId }, include: { vehicle: { include: { host: true } } } }) : null;
  const recipients = new Set([c.openedById, c.assignedToId, r?.customerId, r?.vehicle.host?.userId].filter((v): v is string => Boolean(v) && v !== actorId));
  for (const userId of recipients) { await enqueueNoticeEmail(tx, userId, c.kind, `case:${id}:${c.version}`, true); await tx.inboxNotice.upsert({ where: { eventKey_userId: { eventKey: `case:${id}:${c.version}`, userId } }, update: {}, create: { eventKey: `case:${id}:${c.version}`, userId, category: c.kind, resourceType: "CASE", resourceId: id, title: `${c.kind.toLowerCase()} update`, required: true } }); }
}
export const caseCommandSchema = z.object({ action: z.enum(["reply", "internal", "transition", "assign", "escalate", "appeal", "satisfaction", "override", "safetyClear", "reference"]), version: z.coerce.number().int().min(0), body: z.string().min(1).max(5000), state: z.string().optional(), assigneeId: z.string().optional(), rating: z.coerce.number().int().min(1).max(5).optional(), photoId: z.string().optional(), stepUpCode: z.string().regex(/^\d{6}$/).optional(), confirm: z.enum(["yes", "no"]).optional() });
export async function caseCommand(userId: string, id: string, input: unknown, db: PrismaClient = prisma) {
  const data = caseCommandSchema.parse(input);
  if (data.action === "override") {
    const actor = await marketplaceActor(db, userId);
    if (actor.role !== "SUPER_ADMIN" || data.confirm !== "yes" || data.body.trim().length < 10 || !data.stepUpCode || !(await verifyAuthCode({ email: actor.email, code: data.stepUpCode, ip: null, purpose: "EMERGENCY_OVERRIDE_STEP_UP" })).ok) throw new MarketplaceError("A fresh super-admin step-up code, confirmation and reason are required.", 403);
  }
  return db.$transaction(async tx => {
    const prior = await tx.serviceCase.findUnique({ where: { id } });
    if (!prior) throw new MarketplaceError("Not found.", 404);
    if (prior.reservationId) await lockReservation(tx, prior.reservationId);
    await tx.$queryRaw`SELECT "id" FROM "ServiceCase" WHERE "id"=${id} FOR UPDATE`;
    const { c, role, actor } = await caseAccess(tx, userId, id);
    if (c.retainUntil < new Date() && c.state === "CLOSED") throw new MarketplaceError("This case is archived under the retention policy.", 409);
    if (c.version !== data.version) throw new MarketplaceError("This case changed. Refresh before submitting.", 409);
    const body = safeText(data.body), p = await policy(tx);
    let state = c.state;
    const update: Prisma.ServiceCaseUpdateInput = { version: { increment: 1 } };
    if (data.action === "internal" && role !== "OPERATOR") throw new MarketplaceError("Operator access required.", 403);
    if (["assign", "escalate"].includes(data.action)) {
      if (role !== "OPERATOR") throw new MarketplaceError("Operator access required.", 403);
      if (data.action === "assign") {
        const assignee = await marketplaceActor(tx, data.assigneeId ?? "");
        if (!isOperator(assignee.role, c.kind as ServiceKind) || assignee.id === c.openedById) throw new MarketplaceError("Choose an authorized agent without a party conflict.");
        const vehicle = c.vehicleId ? await tx.vehicle.findUnique({ where: { id: c.vehicleId }, include: { host: true } }) : null;
        const reservation = c.reservationId ? await tx.reservation.findUnique({ where: { id: c.reservationId } }) : null;
        const affiliation = vehicle?.hostId ? await tx.hostEmployee.count({ where: { hostId: vehicle.hostId, userId: assignee.id } }) : 0;
        if (vehicle?.host?.userId === assignee.id || reservation?.customerId === assignee.id || affiliation) throw new MarketplaceError("A party cannot adjudicate their own case.");
        update.assignedToId = assignee.id;
      } else { update.priority = "URGENT"; update.dueAt = new Date(); }
    }
    if (data.action === "reference") {
      if (!c.reservationId || !data.photoId || ["CLOSED", "RESOLVED"].includes(c.state)) throw new MarketplaceError("Original evidence cannot be added in this state.", 409);
      const photo = await tx.conditionPhoto.findFirst({ where: { id: data.photoId, conditionReport: { reservationId: c.reservationId, acceptedAt: { not: null } } } });
      if (!photo) throw new MarketplaceError("Not found.", 404);
      const details = c.details as Record<string, Prisma.InputJsonValue>;
      const originalPhotoIds = Array.isArray(details.originalPhotoIds) ? details.originalPhotoIds as string[] : [];
      update.details = { ...details, originalPhotoIds: [...new Set([...originalPhotoIds, photo.id])] };
    }
    if (data.action === "safetyClear") {
      if (role !== "OPERATOR" || c.kind !== "INCIDENT" || c.state !== "CLOSED" || !c.vehicleId || !await tx.maintenanceRecord.count({ where: { vehicleId: c.vehicleId, serviceDate: { gte: c.createdAt }, service: { in: ["INSPECTION", "REPAIR"] } } })) throw new MarketplaceError("Close the incident and record a subsequent maintenance inspection or repair first.", 409);
      update.safetyBlock = false;
    }
    if (data.action === "override") {
      if (actor.role !== "SUPER_ADMIN" || ["CLOSED", "DECIDED", "RESOLVED"].includes(c.state) || !["CLAIM", "DISPUTE"].includes(c.kind)) throw new MarketplaceError("Overrides cannot reopen a decision; use the appeal workflow.", 403);
      state = c.kind === "DISPUTE" ? "DECIDED" : "RESOLVED"; update.state = state;
      await tx.auditLog.create({ data: { actorId: userId, action: "case.step_up_override", entityType: "ServiceCase", entityId: id, metadata: { reason: body, stepUpVerifiedAt: new Date().toISOString(), fromState: c.state, toState: state } } });
    }
    if (data.action === "transition") {
      state = data.state ?? "";
      if (!(caseStates[c.kind as ServiceKind]?.[c.state] ?? []).includes(state)) throw new MarketplaceError("Invalid case transition.", 409);
      if (["ACCEPTED", "DISPUTED"].includes(state) && c.kind === "CLAIM" && role !== "CUSTOMER") throw new MarketplaceError("Only the customer can accept or dispute the proposed settlement.", 403);
      if (body.length < 10) throw new MarketplaceError("Provide a specific decision reason of at least 10 characters.");
      if (c.dueAt > new Date() && (c.kind === "CLAIM" && state === "ESTIMATE_REVIEW" || c.kind === "DISPUTE" && state === "UNDER_REVIEW")) {
        const responses = await tx.serviceCaseEvent.findMany({ where: { caseId: id, action: { in: ["CUSTOMER_REPLY", "HOST_REPLY"] } }, select: { action: true } });
        const openedByRole = (c.details as { openedByRole?: string }).openedByRole;
        const customerResponded = openedByRole === "CUSTOMER" || responses.some(e => e.action === "CUSTOMER_REPLY");
        const hostResponded = openedByRole === "HOST" || responses.some(e => e.action === "HOST_REPLY");
        if (!customerResponded || c.kind === "DISPUTE" && !hostResponded) throw new MarketplaceError("Wait for the requested party response or the response deadline before advancing.", 409);
      }
      const partyStep = c.kind === "CLAIM" && (state === "EVIDENCE_SUBMITTED" && role === "HOST" || ["ACCEPTED", "DISPUTED"].includes(state) && role === "CUSTOMER");
      if (role !== "OPERATOR" && !partyStep) throw new MarketplaceError("An authorized agent must perform this transition.", 403);
      if (role === "OPERATOR" && c.assignedToId !== userId) throw new MarketplaceError("Assign this case to yourself before deciding it.", 409);
      if (state === "EVIDENCE_SUBMITTED" && !await tx.collaborationFile.count({ where: { caseId: id, scanStatus: "CLEAN", deletedAt: null } }) && !(c.details as { originalPhotoIds?: string[] }).originalPhotoIds?.length) throw new MarketplaceError("Add evidence before submitting.");
      update.state = state; if (!["RESOLVED", "DECIDED", "CLOSED"].includes(state)) update.dueAt = new Date(Date.now() + p.responseHours * 3600000);
      if (state === "CLOSED") { update.closedAt = new Date(); update.retainUntil = afterDays(c.kind === "CLAIM" ? p.claimDays : c.kind === "DISPUTE" ? p.disputeDays : c.kind === "INCIDENT" ? p.incidentDays : p.ticketDays); }
      // Never clear financial REVIEW, release safety blocks, or dispatch money here.
    }
    if (data.action === "appeal") {
      if (!["DECIDED", "CLOSED", "RESOLVED"].includes(c.state) || role === "OPERATOR") throw new MarketplaceError("Only a party may appeal a decision.", 409);
      if (await tx.serviceCaseEvent.count({ where: { caseId: id, action: "APPEAL", actorId: userId } })) throw new MarketplaceError("Your appeal is already recorded.", 409);
      state = c.kind === "DISPUTE" ? "UNDER_REVIEW" : "INITIAL_REVIEW";
      if (!["CLAIM", "DISPUTE"].includes(c.kind)) throw new MarketplaceError("This case does not support an appeal.");
      update.state = state; update.closedAt = null; update.assignedToId = null; update.dueAt = new Date(Date.now() + p.responseHours * 3600000);
      if (c.reservationId) {
        await tx.reservation.update({ where: { id: c.reservationId }, data: { financialDisposition: "REVIEW" } });
        await tx.financialCase.updateMany({ where: { sourceKey: `collaboration-review:${c.reservationId}` }, data: { status: "OPEN", resolvedAt: null, resolution: null, reason: "An appeal requires renewed verified financial review" } });
      }
    }
    if (data.action === "satisfaction") {
      if (c.kind !== "TICKET" || c.openedById !== userId || !["RESOLVED", "CLOSED"].includes(c.state) || !data.rating) throw new MarketplaceError("Feedback is available after your ticket is resolved.");
      update.satisfaction = data.rating;
    }
    if (["reply", "internal"].includes(data.action) && c.state === "CLOSED") throw new MarketplaceError("This case is closed.", 409);
    await tx.serviceCaseEvent.create({ data: { caseId: id, actorId: userId, action: data.action === "reply" ? `${role}_REPLY` : data.action.toUpperCase(), fromState: c.state, toState: state, body, internal: ["internal", "assign", "escalate"].includes(data.action), version: c.version + 1, deadlineAt: c.dueAt } });
    await tx.serviceCase.update({ where: { id }, data: update });
    await notifyCase(tx, id, userId);
    await audit(tx, userId, `service.${data.action}`, "ServiceCase", id);
    return { id };
  }, { timeout: 15000 });
}
export async function readServiceCase(userId: string, id: string) {
  return prisma.$transaction(async tx => {
    const { c, role } = await caseAccess(tx, userId, id);
    await audit(tx, userId, "service.read", "ServiceCase", id);
    return { ...c, role, originalPhotos: c.reservationId ? await tx.conditionPhoto.findMany({ where: { conditionReport: { reservationId: c.reservationId, acceptedAt: { not: null } } }, select: { id: true, category: true, createdAt: true, conditionReport: { select: { phase: true, submittedByRole: true } } } }) : [], events: await tx.serviceCaseEvent.findMany({ where: { caseId: id, ...(role === "OPERATOR" ? {} : { internal: false }) }, orderBy: { version: "asc" } }), files: await tx.collaborationFile.findMany({ where: { caseId: id, deletedAt: null, scanStatus: "CLEAN" }, select: { id: true, purpose: true, sha256: true, createdAt: true } }) };
  });
}
