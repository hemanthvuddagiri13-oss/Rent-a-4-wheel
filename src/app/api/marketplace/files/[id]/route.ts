import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";
import { getHostContext } from "@/lib/host-access";
import { canAccessAdmin } from "@/lib/rbac";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.marketplaceFile.findUnique({ where: { id } });
  if (!file) return new Response("Not found", { status: 404 });
  const vehicle = file.vehicleId ? await prisma.vehicle.findUnique({ where: { id: file.vehicleId }, select: { listingApproval: true, status: true } }) : null;
  const publicPhoto = file.purpose === "LISTING_PHOTO" && file.scanStatus === "CLEAN" && vehicle?.listingApproval === "APPROVED" && vehicle.status === "ACTIVE";
  if (!publicPhoto) {
    const session = await auth();
    if (!session?.user) return new Response("Unauthorized", { status: 401 });
    const context = await getHostContext(session.user.id);
    if (file.uploadedById !== session.user.id && (!(canAccessAdmin(session.user.role) || context?.hostId === file.hostId) || file.scanStatus !== "CLEAN")) return new Response("Forbidden", { status: 403 });
    await prisma.auditLog.create({ data: { actorId: session.user.id, action: "host.file.read", entityType: "MarketplaceFile", entityId: id } });
  }
  const { buffer } = await readPrivateDocument(file.storageKey);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": file.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
