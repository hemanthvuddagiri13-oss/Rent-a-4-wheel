import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";
import { canReadBusinessFile } from "@/lib/business-file-access";
import { visibleJurisdictions } from "@/lib/jurisdiction";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.marketplaceFile.findUnique({ where: { id } });
  if (!file) return new Response("Not found", { status: 404 });
  const vehicle = file.vehicleId ? await prisma.vehicle.findUnique({ where: { id: file.vehicleId, jurisdictionCode: {in: await visibleJurisdictions()} }, select: { listingApproval: true, status: true } }) : null;
  const publicPhoto = file.purpose === "LISTING_PHOTO" && file.scanStatus === "CLEAN" && vehicle?.listingApproval === "APPROVED" && vehicle.status === "ACTIVE";
  if (!publicPhoto) {
    const session = await auth();
    if (!session?.user || !await canReadBusinessFile(prisma, session.user.id, file.hostId, file.scanStatus, file.uploadedById)) return new Response("Not found", { status: 404 });
    await prisma.auditLog.create({ data: { actorId: session.user.id, action: "host.file.read", entityType: "MarketplaceFile", entityId: id } });
  }
  const { buffer } = await readPrivateDocument(file.storageKey);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
