import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";
import { mobileReservationAccess } from "./queries";
import { authenticateMobile, MobileError } from "./auth";

export async function readReportPhoto(req: Request, userId: string, reservationId: string, reportId: string, photoId: string) {
  const authorize = () => prisma.$transaction(async tx => {
    await mobileReservationAccess(tx, userId, reservationId);
    const photo = await tx.conditionPhoto.findFirst({ where: { id: photoId, conditionReportId: reportId, conditionReport: { reservationId } }, select: { storageKey: true } });
    if (!photo) throw new MobileError("NOT_FOUND", 404);
    const stored = await tx.privateObject.findUnique({ where: { key: photo.storageKey } });
    if (!stored || stored.deletedAt || stored.state !== "CLEAN" || stored.writeState !== "STORED" || !["image/jpeg", "image/png", "image/webp"].includes(stored.mimeType)) throw new MobileError("NOT_FOUND", 404);
    return stored;
  });
  const object = await authorize();
  await prisma.auditLog.create({ data: { actorId: userId, action: "mobile.report_photo.read", entityType: "ConditionPhoto", entityId: photoId } });
  const { buffer } = await readPrivateDocument(object.key);
  await authenticateMobile(req.headers);
  const current = await authorize();
  if (current.key !== object.key || current.mimeType !== object.mimeType) throw new MobileError("NOT_FOUND", 404);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": object.mimeType, "Cache-Control": "private, no-store", "Content-Disposition": 'inline; filename="condition-photo"' } });
}
