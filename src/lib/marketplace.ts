import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class MarketplaceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function marketplaceActor(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user?.isActive) throw new MarketplaceError("Sign in to continue.", 401);
  return user;
}

export async function marketplaceHost(tx: Prisma.TransactionClient, userId: string, manage = false) {
  const user = await marketplaceActor(tx, userId);
  if (!["HOST", "HOST_EMPLOYEE"].includes(user.role)) throw new MarketplaceError("Host access required.", 403);
  const own = await tx.hostProfile.findUnique({ where: { userId } });
  const employment = own ? null : await tx.hostEmployee.findFirst({ where: { userId }, include: { host: true } });
  const host = own ?? employment?.host;
  if (!host || host.onboardingStatus === "SUSPENDED") throw new MarketplaceError("Host access unavailable.", 403);
  const role = own ? "OWNER" : employment!.role;
  if (manage && role === "STAFF") throw new MarketplaceError("Only the host owner or manager can change fleet settings.", 403);
  return { host, role };
}

export async function marketplaceVehicle(tx: Prisma.TransactionClient, userId: string, id: string, manage = false) {
  // Same guard ordering as checkout; never acquire a vehicle row before its guard.
  await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + id})`;
  await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id"=${id} FOR UPDATE`;
  const context = await marketplaceHost(tx, userId, manage);
  const vehicle = await tx.vehicle.findUnique({ where: { id } });
  if (!vehicle || vehicle.hostId !== context.host.id) throw new MarketplaceError("Vehicle unavailable.", 404);
  return { ...context, vehicle };
}

export async function marketplaceLimit(userId: string) {
  const key = `marketplace:${userId}`;
  const result = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "MarketplaceRateLimit" ("key","windowStart","count") VALUES (${key},CURRENT_TIMESTAMP,1)
    ON CONFLICT ("key") DO UPDATE SET
      "count"=CASE WHEN "MarketplaceRateLimit"."windowStart" < CURRENT_TIMESTAMP - interval '1 minute' THEN 1 ELSE "MarketplaceRateLimit"."count"+1 END,
      "windowStart"=CASE WHEN "MarketplaceRateLimit"."windowStart" < CURRENT_TIMESTAMP - interval '1 minute' THEN CURRENT_TIMESTAMP ELSE "MarketplaceRateLimit"."windowStart" END
    RETURNING "count"`;
  if (result[0].count > 40) throw new MarketplaceError("Too many requests. Try again in a minute.", 429);
}

const text = z.string().trim().min(1).max(200);
const cents = z.coerce.number().int().min(0).max(10_000_000);
const date = z.string().datetime({ offset: true });
export const listingSchema = z.object({
  id: z.string().optional(), vin: z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{17}$/),
  licensePlate: text, year: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 2), make: text, model: text,
  category: z.enum(["ECONOMY", "SEDAN", "SUV", "LUXURY", "TRUCK"]),
  transmission: z.enum(["AUTOMATIC", "MANUAL"]), fuelType: z.enum(["GASOLINE", "DIESEL", "HYBRID", "ELECTRIC"]),
  seats: z.coerce.number().int().min(1).max(15), mileage: z.coerce.number().int().min(0).max(2_000_000),
  dailyRateCents: cents.min(100), weeklyRateCents: cents.min(100), monthlyRateCents: cents.min(100), securityDepositCents: cents,
  mileageAllowancePerDay: z.coerce.number().int().min(1).max(10000), additionalMileageFeeCents: cents,
  description: z.string().trim().min(20).max(5000), rules: z.string().trim().max(3000), location: text,
  registrationExpiresAt: date, insuranceExpiresAt: date,
  ownerId: z.string().optional(), ownershipType: z.enum(["COMPANY_OWNED", "LEASED_TO_COMPANY", "MANAGED_VEHICLE"]),
  features: z.array(text).max(30),
});

export async function saveListing(userId: string, input: unknown) {
  const data = listingSchema.parse(input);
  return prisma.$transaction(async tx => {
    const context = data.id ? await marketplaceVehicle(tx, userId, data.id, true) : await marketplaceHost(tx, userId, true);
    if (data.ownerId && !await tx.vehicleOwner.findFirst({ where: { id: data.ownerId, hostId: context.host.id } })) throw new MarketplaceError("Choose an owner in your business.");
    const { id, features, ownerId, registrationExpiresAt, insuranceExpiresAt, ...fields } = data;
    const saved = { ...fields, ownerId: ownerId || null, registrationExpiresAt: new Date(registrationExpiresAt), insuranceExpiresAt: new Date(insuranceExpiresAt) };
    const vehicle = id ? await tx.vehicle.update({ where: { id }, data: { ...saved, listingApproval: "PENDING", status: "INACTIVE" } })
      : await tx.vehicle.create({ data: { ...saved, hostId: context.host.id, listingApproval: "PENDING", status: "INACTIVE", slug: `${data.make}-${data.model}-${randomUUID()}`.toLowerCase(), availability: { create: { isBookable: false } } } });
    await tx.vehicleFeatureOnVehicle.deleteMany({ where: { vehicleId: vehicle.id } });
    for (const name of [...new Set(features)]) {
      const feature = await tx.feature.upsert({ where: { name }, create: { name }, update: {} });
      await tx.vehicleFeatureOnVehicle.create({ data: { vehicleId: vehicle.id, featureId: feature.id } });
    }
    await tx.auditLog.create({ data: { actorId: userId, action: id ? "host.listing.update" : "host.listing.create", entityType: "Vehicle", entityId: vehicle.id } });
    return { id: vehicle.id };
  }, { timeout: 15000 });
}

export async function saveHostProfile(userId: string, input: unknown) {
  const data = z.object({ legalName: text, businessName: text, phone: text, addressLine1: text, city: text, state: text, zip: text }).parse(input);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
    const user = await marketplaceActor(tx, userId);
    if (!["CUSTOMER", "HOST"].includes(user.role)) throw new MarketplaceError("Only an account owner can apply or edit this profile.", 403);
    const prior = await tx.hostProfile.findUnique({ where: { userId } });
    if (prior?.onboardingStatus === "SUSPENDED") throw new MarketplaceError("Contact support about your suspended account.", 403);
    const host = await tx.hostProfile.upsert({ where: { userId }, create: { ...data, userId, onboardingStatus: "SUBMITTED" }, update: { ...data, onboardingStatus: "SUBMITTED", approvedAt: null, approvedById: null } });
    await tx.user.update({ where: { id: userId }, data: { role: "HOST" } });
    await tx.auditLog.create({ data: { actorId: userId, action: "host.profile.submitted", entityType: "HostProfile", entityId: host.id } });
    return { id: host.id };
  });
}

export async function hostCommand(userId: string, input: unknown) {
  const data = z.discriminatedUnion("action", [
    z.object({ action: z.literal("owner"), name: text, email: z.string().email(), phone: text }),
    z.object({ action: z.literal("employee"), email: z.string().email(), role: z.enum(["MANAGER", "STAFF"]) }),
    z.object({ action: z.literal("removeEmployee"), id: text }),
    z.object({ action: z.literal("block"), vehicleId: text, startAt: date, endAt: date, reason: z.enum(["MAINTENANCE", "OWNER_REQUEST", "OTHER"]), notes: z.string().max(2000) }),
    z.object({ action: z.literal("unblock"), vehicleId: text, id: text }),
    z.object({ action: z.literal("availability"), vehicleId: text, isBookable: z.boolean() }),
    z.object({ action: z.literal("maintenance"), vehicleId: text, service: z.enum(["OIL_CHANGE", "TIRES", "BRAKES", "INSPECTION", "REGISTRATION", "INSURANCE", "REPAIR", "CLEANING", "OTHER"]), serviceDate: date, mileage: z.coerce.number().int().min(0), costCents: cents, nextServiceDate: date, notes: z.string().max(2000) }),
  ]).parse(input);
  return prisma.$transaction(async tx => {
    const context = "vehicleId" in data ? await marketplaceVehicle(tx, userId, data.vehicleId, true) : await marketplaceHost(tx, userId, true);
    if (data.action === "owner") await tx.vehicleOwner.create({ data: { hostId: context.host.id, name: data.name, email: data.email, phone: data.phone } });
    if (data.action === "employee" || data.action === "removeEmployee") {
      if (context.role !== "OWNER") throw new MarketplaceError("Only the business owner can manage access.", 403);
      if (data.action === "removeEmployee") await tx.hostEmployee.deleteMany({ where: { id: data.id, hostId: context.host.id } });
      else {
        const user = await tx.user.findUnique({ where: { email: data.email.toLowerCase() }, include: { hostEmployments: true } });
        if (!user?.isActive || !["CUSTOMER", "HOST_EMPLOYEE"].includes(user.role) || user.hostEmployments.some(e => e.hostId !== context.host.id)) throw new MarketplaceError("Employee must have an active customer account and no other host affiliation.");
        await tx.hostEmployee.upsert({ where: { hostId_userId: { hostId: context.host.id, userId: user.id } }, create: { hostId: context.host.id, userId: user.id, role: data.role }, update: { role: data.role } });
        await tx.user.update({ where: { id: user.id }, data: { role: "HOST_EMPLOYEE" } });
      }
    }
    if (data.action === "block") {
      const start = new Date(data.startAt), end = new Date(data.endAt);
      if (end <= start) throw new MarketplaceError("End must follow start.");
      // Test overlap directly: maintenance may be planned for an inactive vehicle.
      const overlap = await tx.reservation.findFirst({ where: { vehicleId: data.vehicleId, pickupAt: { lt: end }, returnAt: { gt: start }, OR: [{ status: { in: ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START", "ACTIVE", "RETURN_IN_PROGRESS", "DISPUTED", "UNDER_CLAIM_REVIEW", "PAYMENT_FAILED"] } }, { status: { in: ["CHECKOUT_HOLD", "AWAITING_PAYMENT"] }, expiresAt: { gt: new Date() } }] } });
      if (overlap) throw new MarketplaceError("Those dates overlap a booking or live checkout hold.", 409);
      await tx.vehicleBlock.create({ data: { vehicleId: data.vehicleId, startAt: start, endAt: end, reason: data.reason, notes: data.notes } });
    }
    if (data.action === "unblock") await tx.vehicleBlock.deleteMany({ where: { id: data.id, vehicleId: data.vehicleId } });
    if (data.action === "availability") {
      const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: data.vehicleId } });
      if (data.isBookable && (context.host.onboardingStatus !== "APPROVED" || vehicle.listingApproval !== "APPROVED" || vehicle.status !== "ACTIVE")) throw new MarketplaceError("Host and listing approval are required before accepting bookings.", 409);
      await tx.vehicleAvailabilityConfig.upsert({ where: { vehicleId: data.vehicleId }, create: { vehicleId: data.vehicleId, isBookable: data.isBookable }, update: { isBookable: data.isBookable } });
    }
    if (data.action === "maintenance") {
      await tx.maintenanceRecord.create({ data: { vehicleId: data.vehicleId, service: data.service, serviceDate: new Date(data.serviceDate), mileage: data.mileage, costCents: data.costCents, nextServiceDate: new Date(data.nextServiceDate), notes: data.notes } });
      await tx.vehicle.update({ where: { id: data.vehicleId }, data: { nextMaintenanceDueAt: new Date(data.nextServiceDate) } });
    }
    await tx.auditLog.create({ data: { actorId: userId, action: `host.${data.action}`, entityType: "HostProfile", entityId: context.host.id } });
    return { success: true };
  }, { timeout: 15000 });
}
