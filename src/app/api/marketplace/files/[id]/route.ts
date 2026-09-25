import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";
import { canReadBusinessFile } from "@/lib/business-file-access";
import { visibleJurisdictions } from "@/lib/jurisdiction";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authorize = async () => {
  const file = await prisma.marketplaceFile.findUnique({ where: { id } });
  if (!file) throw new Error("Not found");
  const vehicle = file.vehicleId ? await prisma.vehicle.findUnique({ where: { id: file.vehicleId, jurisdictionCode: {in: await visibleJurisdictions()} }, select: { listingApproval: true, status: true } }) : null;
  const publicPhoto = file.purpose === "LISTING_PHOTO" && file.scanStatus === "CLEAN" && vehicle?.listingApproval === "APPROVED" && vehicle.status === "ACTIVE";
  if (!publicPhoto) {
    const session = await auth();
    if (!session?.user || !await canReadBusinessFile(prisma, session.user.id, file.hostId, file.scanStatus, file.uploadedById)) throw new Error("Not found");
    return { file, actorId: session.user.id };
  }
  return { file, actorId: null };
  };
  try {
  const { file, actorId } = await authorize();
  if (actorId) await prisma.auditLog.create({ data: { actorId, action: "host.file.read", entityType: "MarketplaceFile", entityId: id } });
  const { buffer, revalidate } = await readPrivateDocument(file.storageKey);
  const { file: current } = await authorize();
  if (current.storageKey !== file.storageKey || current.mimeType !== file.mimeType || current.sha256 !== file.sha256 || current.hostId !== file.hostId || current.vehicleId !== file.vehicleId || current.purpose !== file.purpose || current.uploadedById !== file.uploadedById) throw new Error("Not found");
  await revalidate();
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("Not found", { status: 404 }); }
}
