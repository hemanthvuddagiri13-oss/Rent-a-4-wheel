import type { Prisma } from "@prisma/client";
import { activeHostEmployeeWhere } from "@/lib/host-access";

// No session role, cached HostContext, signer or historical uploader grants
// business-file access. The current tenant owner or MANAGER may read; STAFF
// handles trips but has no business-document permission. Removed, disabled or
// expired memberships do not grant access, even to their historical uploads.
export async function canReadBusinessFile(tx: Prisma.TransactionClient, userId: string, hostId: string, scanStatus = "CLEAN", uploadedById?: string) {
  const actor = await tx.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  const host = await tx.hostProfile.findUnique({ where: { id: hostId }, select: { userId: true, onboardingStatus: true } });
  if (!actor?.isActive || !host) return false;
  if (["ADMIN", "SUPER_ADMIN"].includes(actor.role)) return scanStatus === "CLEAN";
  if (host.onboardingStatus === "SUSPENDED" || !["HOST", "HOST_EMPLOYEE"].includes(actor.role)) return false;
  if (scanStatus !== "CLEAN" && uploadedById !== userId) return false;
  if (actor.role === "HOST" && host.userId === userId) return true;
  const employee = await tx.hostEmployee.findFirst({ where: activeHostEmployeeWhere(userId, hostId), select: { role: true } });
  return employee?.role === "MANAGER";
}
