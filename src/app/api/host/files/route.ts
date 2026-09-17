import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { marketplaceHost, marketplaceVehicle, marketplaceLimit, MarketplaceError } from "@/lib/marketplace";
import { InvalidDocumentError, MAX_DOCUMENT_SIZE_BYTES, scanForMalware, validateAndSanitizeDocument } from "@/lib/documents";
import { storePrivateDocument } from "@/lib/storage";
import { safeLog } from "@/lib/safe-log";
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  try {
    await marketplaceLimit(session.user.id);
    await marketplaceHost(prisma, session.user.id, true);
    const form = await req.formData(), file = form.get("file"), vehicleId = String(form.get("vehicleId") || ""), purpose = String(form.get("purpose"));
    if (!(file instanceof File) || file.size > MAX_DOCUMENT_SIZE_BYTES || !["OWNERSHIP", "REGISTRATION", "INSURANCE", "LISTING_PHOTO"].includes(purpose)) throw new MarketplaceError("Choose an image under 8 MB and a valid purpose.");
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { hostId: true } });
    const context = await marketplaceHost(prisma, session.user.id, true);
    if (!vehicle || vehicle.hostId !== context.host.id) throw new MarketplaceError("Vehicle unavailable.", 404);
    const sanitized = await validateAndSanitizeDocument(Buffer.from(await file.arrayBuffer()), file.type);
    const scan = await scanForMalware(sanitized.buffer);
    if (scan.status === "INFECTED") throw new MarketplaceError("File rejected by the security scanner.");
    if (scan.status !== "CLEAN" && (process.env.NODE_ENV === "production" || process.env.ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV !== "true")) throw new MarketplaceError("Uploads are temporarily unavailable while the security scanner is offline.", 503);
    const stored = await storePrivateDocument(sanitized.buffer, sanitized.mimeType);
    const result = await prisma.$transaction(async tx => {
      const { host } = await marketplaceVehicle(tx, session.user.id, vehicleId, true);
      const record = await tx.marketplaceFile.create({ data: { hostId: host.id, vehicleId, uploadedById: session.user.id, purpose, storageKey: stored.storageKey, mimeType: sanitized.mimeType, sha256: sanitized.sha256, scanStatus: scan.status === "CLEAN" ? "CLEAN" : "QUARANTINED" } });
      if (purpose === "LISTING_PHOTO" && record.scanStatus === "CLEAN") await tx.vehicleImage.create({ data: { vehicleId, url: `/api/marketplace/files/${record.id}`, alt: "Host vehicle photo", position: await tx.vehicleImage.count({ where: { vehicleId } }) } });
      await tx.auditLog.create({ data: { actorId: session.user.id, action: "host.file.upload", entityType: "MarketplaceFile", entityId: record.id } });
      return { id: record.id, scanStatus: record.scanStatus };
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MarketplaceError || error instanceof InvalidDocumentError) return NextResponse.json({ error: error.message }, { status: error instanceof MarketplaceError ? error.status : 400 });
    safeLog("HOST_FILE_UPLOAD_FAILED", error);
    return NextResponse.json({ error: "Unable to upload. Please try again." }, { status: 500 });
  }
}
