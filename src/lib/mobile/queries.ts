import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { marketplaceHost } from "@/lib/marketplace";
import { participant, collaborationScopes } from "@/lib/collaboration-access";
import { conversationAccess } from "@/lib/conversations";
import { caseAccess } from "@/lib/service-cases";
import { visibleJurisdictions, requireVehicleJurisdiction } from "@/lib/jurisdiction";
import { requireReleaseFeature } from "@/lib/release-control";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { financialProjection } from "@/lib/financial-projection";
import { authenticateMobile, MobileError } from "./auth";
import { pageInput } from "./http";

export const mobileVehicleSelect = { id: true, slug: true, year: true, make: true, model: true, category: true, transmission: true, fuelType: true, seats: true, dailyRateCents: true, securityDepositCents: true, location: true, jurisdictionCode: true } satisfies Prisma.VehicleSelect;
export const mobileReservationSelect = { id: true, confirmationNumber: true, vehicleId: true, status: true, pickupAt: true, returnAt: true, bookingTimezone: true, pickupLocation: true, expiresAt: true, subtotalCents: true, extrasCents: true, discountCents: true, taxCents: true, feesCents: true, totalCents: true, depositCents: true, bookingFingerprint: true } satisfies Prisma.ReservationSelect;
export async function mobileReservationAccess(tx: Prisma.TransactionClient, userId: string, id: string, ownerOnly = false) {
  const reservation = await tx.reservation.findUnique({ where: { id }, select: { customerId: true, vehicleId: true } });
  if (!reservation || ownerOnly && reservation.customerId !== userId) throw new MobileError("NOT_FOUND", 404);
  return participant(tx, userId, reservation, "MESSAGE");
}
function collection<T extends { id: string }>(rows: T[], limit: number) {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}
export async function mobileQuery(req: Request, parts: string[]) {
  const [resource, id, action] = parts;
  const { limit, cursor } = pageInput(req);
  const page = { take: limit + 1, orderBy: { id: "asc" as const }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
  if (resource === "vehicles" && id && action === "photos" && parts.length === 3) {
    await mobileQuery(req, ["vehicles", id]);
    const v = await prisma.vehicle.findUniqueOrThrow({ where: { id }, select: { hostId: true } });
    // Only explicit public listing uploads belonging to this vehicle's host.
    // Unverified VehicleImage URLs and arbitrary supplied photos are never published.
    const files = v.hostId ? await prisma.marketplaceFile.findMany({ where: { vehicleId: id, hostId: v.hostId, purpose: "LISTING_PHOTO", scanStatus: "CLEAN", mimeType: { in: ["image/jpeg", "image/png", "image/webp"] } }, select: { id: true }, take: 12, orderBy: { createdAt: "asc" } }) : [];
    return { items: files.map(f => ({ id: f.id, path: `/api/marketplace/files/${encodeURIComponent(f.id)}`, alt: "Host-authorized vehicle listing photo" })) };
  }
  if (resource === "vehicles" && !action && parts.length <= 2) {
    const codes: string[] = [];
    for (const code of await visibleJurisdictions()) {
      try { await requireReleaseFeature("booking", prisma, code); codes.push(code); }
      catch { /* Incomplete release approval must not make inventory visible. */ }
    }
    const safety = await prisma.serviceCase.findMany({ where: { safetyBlock: true, vehicleId: { not: null } }, select: { vehicleId: true } });
    const where: Prisma.VehicleWhereInput = { id: { notIn: safety.map(row => row.vehicleId!) }, status: "ACTIVE", isDemo: false, listingApproval: "APPROVED", jurisdictionCode: { in: codes }, AND: [{ OR: [{ hostId: null }, { host: { onboardingStatus: "APPROVED" } }] }, { OR: [{ availability: null }, { availability: { isBookable: true } }] }] };
    if (!id) return collection(await prisma.vehicle.findMany({ where, select: mobileVehicleSelect, ...page }), limit);
    return prisma.$transaction(async tx => {
      const vehicle = await tx.vehicle.findFirst({ where: { AND: [where, { id }] }, select: mobileVehicleSelect });
      if (!vehicle) throw new MobileError("NOT_FOUND", 404);
      await requireVehicleJurisdiction(tx, id, "SEARCH"); return vehicle;
    });
  }
  const actor = await authenticateMobile(req.headers);
  if (resource === "reservations" && action === "reports" && parts[4] === "photos" && parts.length === 6) {
    const { readReportPhoto } = await import("./report-photo");
    return readReportPhoto(actor.userId, id, parts[3], parts[5]);
  }
  if (resource === "files" && id && parts.length === 2) {
    const { readMobileDocument } = await import("./files"); return readMobileDocument(req, id);
  }
  if (parts.length === 1 && resource === "me") return { id: actor.userId, role: actor.role };
  if (resource === "reservations" && !id) return collection(await prisma.reservation.findMany({ where: { customerId: actor.userId }, select: mobileReservationSelect, ...page }), limit);
  if (resource === "reservations" && id && parts.length <= 3) {
    return prisma.$transaction(async tx => {
      await mobileReservationAccess(tx, actor.userId, id);
      if (!action) return tx.reservation.findUniqueOrThrow({ where: { id }, select: mobileReservationSelect });
      if (action === "agreement-preview") {
        const legal = await tx.legalDocument.findUnique({ where: { type: "RENTAL_AGREEMENT" }, select: { type: true, version: true, content: true, needsAttorneyReview: true } });
        if (!legal) throw new MobileError("NOT_FOUND", 404);
        return { ...legal, contentHash: createHash("sha256").update(legal.content).digest("hex") };
      }
      if (action === "pricing") {
        const r = await tx.reservation.findUniqueOrThrow({ where: { id }, select: mobileReservationSelect });
        const quote = await tx.financeQuote.findUnique({ where: { reservationId: id }, select: { terms: true } });
        const terms = quote?.terms as { amounts?: { guestServiceCents?: number; protectionCents?: number; guestProcessingCents?: number; commissionCents?: number; hostNetCents?: number; riskReserveCents?: number } } | undefined;
        const a = terms?.amounts;
        // Only the current owner of this vehicle's tenant sees host financial terms.
        // Being a customer, employee, or operator does not confer ownership.
        const owner = r.vehicleId && actor.role === "HOST" ? await tx.vehicle.findFirst({ where: { id: r.vehicleId, host: { userId: actor.userId, onboardingStatus: { not: "SUSPENDED" } } }, select: { id: true } }) : null;
        return { subtotalCents: r.subtotalCents, extrasCents: r.extrasCents, discountCents: r.discountCents, taxCents: r.taxCents, totalCents: r.totalCents, depositCents: r.depositCents,
          platformFeeCents: a?.guestServiceCents ?? null, protectionCents: a?.protectionCents ?? null, processingCents: a?.guestProcessingCents ?? null,
          ...(owner ? { hostCommissionCents: a?.commissionCents ?? null, hostEarningsCents: a?.hostNetCents ?? null, reserveCents: a?.riskReserveCents ?? null } : {}), approval: "SAMPLE_UNAPPROVED" };
      }
      if (action === "payment-status") {
        await mobileReservationAccess(tx, actor.userId, id, true);
        const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { payments: true, deposit: { include: { operation: true } }, refunds: true } });
        return { status: r.status, depositRequired: r.depositCents > 0, ...financialProjection(r) };
      }
      if (action === "agreements") return { items: await tx.agreementAcceptance.findMany({ where: { reservationId: id }, select: { id: true, type: true, documentVersion: true, contentHash: true, signedAt: true }, take: 20, orderBy: { signedAt: "desc" } }) };
      if (action === "trip") return { trip: await tx.trip.findUnique({ where: { reservationId: id }, select: { startedAt: true, endedAt: true, startMileage: true, endMileage: true, startFuelLevel: true, endFuelLevel: true } }), gate: await evaluateTripStartGate(id, tx) };
      if (action === "documents") return { items: await tx.driverDocument.findMany({ where: { reservationId: id, deletedAt: null }, select: { id: true, type: true, status: true, malwareScanStatus: true }, take: 20, orderBy: { createdAt: "desc" } }) };
      if (action === "reports") return { items: await tx.conditionReport.findMany({ where: { reservationId: id }, select: { id: true, phase: true, submittedByRole: true, mileage: true, fuelLevel: true, damageNotes: true, acceptedAt: true, photos: { select: { id: true, category: true } } }, take: 4, orderBy: { createdAt: "asc" } }) };
      throw new MobileError("NOT_FOUND", 404);
    });
  }
  if (resource === "documents" && !id) return collection(await prisma.driverDocument.findMany({ where: { userId: actor.userId, deletedAt: null }, select: { id: true, type: true, status: true, malwareScanStatus: true, reservationId: true }, ...page }), limit);
  if (resource === "notifications" && !id) return collection(await prisma.inboxNotice.findMany({ where: { userId: actor.userId }, select: { id: true, category: true, title: true, readAt: true, createdAt: true, resourceType: true, resourceId: true }, ...page }), limit);
  if (resource === "conversations" && !action && parts.length <= 2) {
    return prisma.$transaction(async tx => {
      if (!id) { const { conversationWhere } = await collaborationScopes(tx, actor.userId); return collection(await tx.conversation.findMany({ where: conversationWhere, select: { id: true, reservationId: true, vehicleId: true, updatedAt: true }, ...page }), limit); }
      await conversationAccess(tx, actor.userId, id);
      return collection(await tx.conversationMessage.findMany({ where: { conversationId: id, deletedAt: null }, select: { id: true, body: true, createdAt: true, editedAt: true, version: true }, ...page }), limit);
    });
  }
  if (resource === "cases" && id && action === "events" && parts.length === 3) {
    return prisma.$transaction(async tx => {
      await caseAccess(tx, actor.userId, id);
      return collection(await tx.serviceCaseEvent.findMany({ where: { caseId: id, internal: false }, select: { id: true, body: true, action: true, createdAt: true }, ...page }), limit);
    });
  }
  if (resource === "cases" && !action && parts.length <= 2) {
    return prisma.$transaction(async tx => {
      if (id) await caseAccess(tx, actor.userId, id);
      const { caseWhere } = await collaborationScopes(tx, actor.userId);
      const select = { id: true, kind: true, category: true, title: true, state: true, version: true, reservationId: true } as const;
      if (id) return tx.serviceCase.findUniqueOrThrow({ where: { id }, select });
      return collection(await tx.serviceCase.findMany({ where: caseWhere, select, ...page }), limit);
    });
  }
  if (resource === "host" && parts.length === 2) {
    return prisma.$transaction(async tx => {
      const { host, role } = await marketplaceHost(tx, actor.userId);
      if (id === "fleet") return collection(await tx.vehicle.findMany({ where: { hostId: host.id }, select: { ...mobileVehicleSelect, status: true, listingApproval: true }, ...page }), limit);
      if (id === "reservations") return collection(await tx.reservation.findMany({ where: { vehicle: { hostId: host.id } }, select: mobileReservationSelect, ...page }), limit);
      if (id === "earnings") {
        if (role !== "OWNER") throw new MobileError("FORBIDDEN", 403);
        const rows = await tx.hostEarning.findMany({ where: { hostId: host.id }, select: { id: true, reservationId: true, currency: true, grossCents: true, commissionCents: true, hostDiscountCents: true, netCents: true, refundedCents: true, adjustmentCents: true, holdReason: true }, ...page });
        return collection(rows.map(({ holdReason, ...row }) => ({ ...row, held: Boolean(holdReason), payoutEnabled: false })), limit);
      }
      throw new MobileError("NOT_FOUND", 404);
    });
  }
  throw new MobileError("NOT_FOUND", 404);
}
