import { handoffSchema, calendarInput, hostAvailabilityInput } from "@/lib/validations/host-mobile";
import { prisma } from "@/lib/prisma";
import { marketplaceHost, marketplaceVehicle, hostCommand } from "@/lib/marketplace";
import { tripParticipant } from "@/lib/trip-experience";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { recordIdentityHandoff } from "@/lib/identity-handoff";
import { mobileMutation } from "./mutation";
import { MobileError } from "./auth";

export async function hostRead(userId: string, parts: string[]) {
  return prisma.$transaction(async tx => {
    const { host, role } = await marketplaceHost(tx, userId);
    if (parts.length === 2 && parts[1] === "context") {
      const [fleetCount, upcomingCount, activeCount] = await Promise.all([
        tx.vehicle.count({ where: { hostId: host.id } }),
        tx.reservation.count({ where: { vehicle: { hostId: host.id }, pickupAt: { gt: new Date() }, status: { in: ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"] } } }),
        tx.reservation.count({ where: { vehicle: { hostId: host.id }, status: { in: ["ACTIVE", "RETURN_IN_PROGRESS"] } } }),
      ]);
      return { role, name: host.businessName || host.legalName, canManageFleet: role !== "STAFF", canViewEarnings: role === "OWNER", fleetCount, upcomingCount, activeCount, liveFinanceEnabled: false };
    }
    if (parts.length === 3 && parts[1] === "vehicles") {
      const v = await tx.vehicle.findFirst({ where: { id: parts[2], hostId: host.id }, select: { id: true, year: true, make: true, model: true, description: true, rules: true, location: true, mileage: true, status: true, listingApproval: true, isDemo: true, availability: { select: { isBookable: true } } } });
      if (!v) throw new MobileError("NOT_FOUND", 404);
      const { availability, ...vehicle } = v;
      return { ...vehicle, isBookable: availability?.isBookable ?? true };
    }
    if (parts.length === 3 && parts[1] === "trips") {
      const { reservation: r, role: participantRole } = await tripParticipant(tx, userId, parts[2]);
      if (participantRole !== "HOST" || r.vehicle.hostId !== host.id) throw new MobileError("NOT_FOUND", 404);
      const handoff = await tx.identityHandoffVerification.findUnique({ where: { reservationId: r.id }, select: { verifiedAt: true } });
      const keys = await tx.tripChecklist.findUnique({ where: { reservationId_phase_role_step: { reservationId: r.id, phase: "PICKUP", role: "HOST", step: "KEYS_RELEASED" } }, select: { completedAt: true } });
      return { id: r.id, customerName: (await tx.user.findUnique({ where: { id: r.customerId }, select: { name: true } }))?.name ?? "Guest", handoffVerified: Boolean(handoff?.verifiedAt), keysReleased: Boolean(keys), keyReleaseGate: await evaluateTripStartGate(r.id, tx, "KEY_RELEASE") };
    }
    throw new MobileError("NOT_FOUND", 404);
  });
}
export async function hostWrite(req: Request, userId: string, parts: string[], input: unknown) {
  const id = parts[2];
  if (parts.length === 4 && parts[1] === "vehicles" && parts[3] === "calendar") {
    const data = calendarInput.parse(input), start = new Date(data.startAt), end = new Date(data.endAt);
    if (end <= start || end.getTime() - start.getTime() > 366 * 86400000) throw new MobileError("INVALID_REQUEST", 400);
    return prisma.$transaction(async tx => {
      const { host } = await marketplaceHost(tx, userId);
      if (!await tx.vehicle.findFirst({ where: { id, hostId: host.id }, select: { id: true } })) throw new MobileError("NOT_FOUND", 404);
      const blocks = await tx.vehicleBlock.findMany({ where: { vehicleId: id, startAt: { lt: end }, endAt: { gt: start } }, select: { id: true, startAt: true, endAt: true, reason: true, notes: true }, orderBy: { startAt: "asc" }, take: 201 });
      const reservations = await tx.reservation.findMany({ where: { vehicleId: id, pickupAt: { lt: end }, returnAt: { gt: start }, OR: [{ status: { notIn: ["CHECKOUT_HOLD", "AWAITING_PAYMENT", "EXPIRED", "CANCELLED_BY_HOST", "CANCELLED_BY_CUSTOMER", "COMPLETED"] } }, { status: { in: ["CHECKOUT_HOLD", "AWAITING_PAYMENT"] }, expiresAt: { gt: new Date() } }] }, select: { id: true, confirmationNumber: true, status: true, pickupAt: true, returnAt: true }, orderBy: { pickupAt: "asc" }, take: 201 });
      return { blocks: blocks.slice(0, 200), reservations: reservations.slice(0, 200), truncated: blocks.length > 200 || reservations.length > 200 };
    });
  }
  if (parts.length === 4 && parts[1] === "vehicles" && parts[3] === "availability") {
    const data = hostAvailabilityInput.parse(input);
    return mobileMutation(req, "host.availability", { vehicleId: id, ...data }, async (tx, actor) => { await marketplaceVehicle(tx, actor, id, true); }, (tx, actor) => hostCommand(actor, { ...data, vehicleId: id }, tx));
  }
  if (parts.length === 4 && parts[1] === "trips" && parts[3] === "handoff") {
    const data = handoffSchema.parse(input);
    return mobileMutation(req, "host.handoff", { id, ...data }, async (tx, actor) => {
      const { role } = await tripParticipant(tx, actor, id); if (role !== "HOST") throw new MobileError("FORBIDDEN", 403);
    }, (tx, actor) => recordIdentityHandoff(actor, id, data, tx));
  }
  throw new MobileError("NOT_FOUND", 404);
}
