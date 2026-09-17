import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canManageSettings } from "@/lib/rbac";
import { marketplaceActor, MarketplaceError, marketplaceLimit } from "@/lib/marketplace";
import { z } from "zod";
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !canManageSettings(session.user.role)) return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    await marketplaceLimit(session.user.id);
    const data = z.discriminatedUnion("action", [
      z.object({ action: z.literal("host"), id: z.string(), status: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]), reason: z.string().trim().min(5).max(2000) }),
      z.object({ action: z.literal("vehicle"), id: z.string(), status: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().min(5).max(2000) }),
    ]).parse(await req.json());
    await prisma.$transaction(async tx => {
      const actor = await marketplaceActor(tx, session.user.id);
      if (!canManageSettings(actor.role)) throw new MarketplaceError("Forbidden", 403);
      if (data.action === "host") await tx.hostProfile.update({ where: { id: data.id }, data: { onboardingStatus: data.status as "APPROVED" | "REJECTED" | "SUSPENDED", approvedAt: data.status === "APPROVED" ? new Date() : null, approvedById: actor.id } });
      else {
        await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + data.id})`;
        const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: data.id }, include: { host: true, images: true, agreementAcceptances: { where: { type: "HOST_AGREEMENT" } } } });
        if (data.status === "APPROVED" && vehicle.hostId) {
          const files = await tx.marketplaceFile.findMany({ where: { vehicleId: vehicle.id, hostId: vehicle.hostId, scanStatus: "CLEAN" } });
          if (vehicle.host?.onboardingStatus !== "APPROVED" || !vehicle.registrationExpiresAt || vehicle.registrationExpiresAt <= new Date() || !vehicle.insuranceExpiresAt || vehicle.insuranceExpiresAt <= new Date()) throw new MarketplaceError("Approved host and current registration/insurance dates required.", 409);
          if (["OWNERSHIP", "REGISTRATION", "INSURANCE", "LISTING_PHOTO"].some(purpose => !files.some(f => f.purpose === purpose))) throw new MarketplaceError("Clean ownership, registration, insurance and listing-photo uploads are required.", 409);
          if (!vehicle.agreementAcceptances.some(a => a.signedPdfStorageKey)) throw new MarketplaceError("A signed host agreement PDF is required.", 409);
        }
        await tx.vehicle.update({ where: { id: data.id }, data: { listingApproval: data.status, status: data.status === "APPROVED" ? "ACTIVE" : "INACTIVE" } });
        await tx.vehicleAvailabilityConfig.upsert({ where: { vehicleId: data.id }, create: { vehicleId: data.id, isBookable: data.status === "APPROVED" }, update: { isBookable: data.status === "APPROVED" } });
      }
      await tx.auditLog.create({ data: { actorId: actor.id, action: `admin.${data.action}.${data.status.toLowerCase()}`, entityType: data.action === "host" ? "HostProfile" : "Vehicle", entityId: data.id, metadata: { reason: data.reason } } });
    });
    return Response.json({ success: true });
  } catch (error) { return Response.json({ error: error instanceof MarketplaceError ? error.message : "Unable to save this approval. Check the required evidence." }, { status: error instanceof MarketplaceError ? error.status : 409 }); }
}
