import { requireReleaseFeature } from "@/lib/release-control";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lockReservation, withReservationLock } from "@/lib/financial-locks";
import { MarketplaceError, marketplaceActor, marketplaceHost } from "@/lib/marketplace";
import { participant, policy, afterDays, safeText, isOperator, audit } from "@/lib/collaboration-access";

const schema = z.object({ reservationId: z.string(), subject: z.enum(["VEHICLE", "HOST", "CUSTOMER"]), rating: z.coerce.number().int().min(1).max(5), body: z.string().min(3).max(5000), cleanliness: z.coerce.number().int().min(1).max(5), communication: z.coerce.number().int().min(1).max(5), accuracy: z.coerce.number().int().min(1).max(5), version: z.coerce.number().int().optional() });
export async function saveTripReview(userId: string, input: unknown) {
  await requireReleaseFeature("reviews");
  const data = schema.parse(input);
  return withReservationLock(data.reservationId, async tx => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: data.reservationId }, include: { trip: true, vehicle: true } });
    const { role } = await participant(tx, userId, r, "REVIEW");
    if (role === "OPERATOR" || (data.subject === "CUSTOMER" ? role !== "HOST" : role !== "CUSTOMER")) throw new MarketplaceError("Only the trip participants can review one another.", 403);
    // Employee reviews would allow many reviews from one business. The host owner
    // authors the business's single private customer review.
    const host = await tx.hostProfile.findUnique({ where: { id: r.vehicle.hostId ?? "" } });
    if (role === "HOST" && host?.userId !== userId) throw new MarketplaceError("Only the host owner can submit the customer review.", 403);
    const p = await policy(tx);
    if (r.status !== "COMPLETED" || !r.trip?.startedAt || !r.trip.endedAt || r.vehicle.isDemo || Date.now() > r.trip.endedAt.getTime() + p.reviewDays * 86400000) throw new MarketplaceError("Reviews are available only within the completed-trip review window.", 409);
    const subjectId = data.subject === "VEHICLE" ? r.vehicleId : data.subject === "HOST" ? host?.id : r.customerId;
    if (!subjectId) throw new MarketplaceError("Review subject unavailable.");
    const prior = await tx.tripReview.findUnique({ where: { reservationId_reviewerId_subject: { reservationId: r.id, reviewerId: userId, subject: data.subject } } });
    const content = { rating: data.rating, body: safeText(data.body), categories: { cleanliness: data.cleanliness, communication: data.communication, accuracy: data.accuracy } };
    if (prior && (data.version !== prior.version || Date.now() > prior.createdAt.getTime() + p.editMinutes * 60000 || prior.publishAfter <= new Date())) throw new MarketplaceError("This review can no longer be edited.", 409);
    const review = prior ? await tx.tripReview.update({ where: { id: prior.id }, data: { ...content, version: { increment: 1 } } }) : await tx.tripReview.create({ data: { ...content, reservationId: r.id, reviewerId: userId, subject: data.subject, subjectId, publishAfter: new Date(r.trip.endedAt.getTime() + p.blindDays * 86400000), retainUntil: afterDays(p.reviewRetentionDays) } });
    await tx.reviewHistory.create({ data: { reviewId: review.id, actorId: userId, action: prior ? "EDIT" : "CREATE", reason: "Author submission", snapshot: { ...content, version: review.version } } });
    // Keep the full blind period even when the other party posts: neither party
    // gains an edit advantage by watching publication timing.
    return { id: review.id };
  });
}
export async function moderateTripReview(userId: string, id: string, action: "hide" | "restore" | "report", reason: string) {
  return prisma.$transaction(async tx => {
    const actor = await marketplaceActor(tx, userId);
    const scope = await tx.tripReview.findUniqueOrThrow({ where: { id }, select:{reservationId:true} });
    await lockReservation(tx,scope.reservationId);
    await tx.$queryRaw`SELECT id FROM "TripReview" WHERE id=${id} FOR UPDATE`;
    const review = await tx.tripReview.findUniqueOrThrow({ where: { id } });
    if (action === "report") {
      if (review.subject === "CUSTOMER") {
        const r = await tx.reservation.findUniqueOrThrow({ where: { id: review.reservationId } });
        await participant(tx, userId, r, "REVIEW");
      } else if (review.publishAfter > new Date() || review.hidden) throw new MarketplaceError("Not found.", 404);
      return tx.communityReport.upsert({ where: { actorId_entityType_entityId: { actorId: userId, entityType: "REVIEW", entityId: id } }, update: {}, create: { actorId: userId, entityType: "REVIEW", entityId: id, reason: safeText(reason) } });
    }
    if (!review.body || review.retainUntil < new Date()) throw new MarketplaceError("This review is archived.", 409);
    if (!isOperator(actor.role, "REVIEW")) throw new MarketplaceError("Review moderation access required.", 403);
    await tx.reviewHistory.create({ data: { reviewId: id, actorId: userId, action: action.toUpperCase(), reason: safeText(reason), snapshot: { hidden: review.hidden, version: review.version } } });
    await tx.tripReview.update({ where: { id }, data: { hidden: action === "hide", version: { increment: 1 } } });
    await audit(tx, userId, `review.${action}`, "TripReview", id);
    return { id };
  });
}
export async function publicTripReviews(subject: "VEHICLE" | "HOST", subjectId: string) {
  try { await requireReleaseFeature("reviews"); } catch { return {reviews:[],average:null,count:0}; }
  const eligible = await prisma.reservation.findMany({ where: { status: "COMPLETED", trip: { startedAt: { not: null }, endedAt: { not: null } }, vehicle: { isDemo: false, ...(subject === "VEHICLE" ? { id: subjectId } : { hostId: subjectId }) } }, select: { id: true } });
  const where = { subject, subjectId, hidden: false, publishAfter: { lte: new Date() }, reservationId: { in: eligible.map(r => r.id) } };
  const [reviews, aggregate] = await Promise.all([prisma.tripReview.findMany({ where, take: 50, orderBy: { createdAt: "desc" }, select: { id: true, rating: true, body: true, categories: true, createdAt: true } }), prisma.tripReview.aggregate({ where, _avg: { rating: true }, _count: true })]);
  return { reviews, average: aggregate._avg.rating, count: aggregate._count };
}
export async function customerReputation(userId: string, customerId: string) {
  const { host } = await marketplaceHost(prisma, userId);
  if (!await prisma.reservation.count({ where: { customerId, vehicle: { hostId: host.id } } })) throw new MarketplaceError("Not found.", 404);
  const eligible = await prisma.reservation.findMany({ where: { customerId, status: "COMPLETED", trip: { endedAt: { not: null }, startedAt: { not: null } } }, select: { id: true } });
  await audit(prisma, userId, "reputation.read", "User", customerId);
  return prisma.tripReview.findMany({ where: { subject: "CUSTOMER", subjectId: customerId, hidden: false, publishAfter: { lte: new Date() }, reservationId: { in: eligible.map(r => r.id) } }, select: { rating: true, body: true, createdAt: true }, take: 30 });
}
