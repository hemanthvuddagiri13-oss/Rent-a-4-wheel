import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { tripParticipant } from "@/lib/trip-experience";
import { readPrivateDocument } from "@/lib/storage";
import { canAccessAdmin } from "@/lib/rbac";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; photoId: string }> }) {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });
  const { id, photoId } = await params;
  if (!canAccessAdmin(session.user.role)) { try { await tripParticipant(prisma, session.user.id, id); } catch { return new Response("Forbidden", { status: 403 }); } }
  const photo = await prisma.conditionPhoto.findFirst({ where: { id: photoId, conditionReport: { reservationId: id } } });
  if (!photo) return new Response("Not found", { status: 404 });
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "condition-photo.read", entityType: "ConditionPhoto", entityId: photo.id } });
  const { buffer } = await readPrivateDocument(photo.storageKey);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="condition-photo"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
