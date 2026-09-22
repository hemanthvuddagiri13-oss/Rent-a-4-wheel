import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { verifyAuthCode } from "@/lib/auth-code";
const ABSOLUTE_MS = 7 * 86400000, IDLE_MS = 30 * 60000;
export async function listDeviceSessions(userId:string){return prisma.session.findMany({where:{userId,revokedAt:null,expires:{gt:new Date()},lastSeenAt:{gt:new Date(Date.now()-IDLE_MS)}},select:{id:true,device:true,lastSeenAt:true,expires:true},orderBy:{createdAt:"desc"}});}
export async function createDeviceSession(userId: string, device = "Browser") {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    if (!await tx.user.count({ where: { id: userId, isActive: true } })) throw new Error("SESSION_UNAVAILABLE");
    const row = await tx.session.create({ data: { userId, sessionToken: createHash("sha256").update(randomBytes(32)).digest("hex"), expires: new Date(Date.now() + ABSOLUTE_MS), device: ["Browser", "Mobile browser"].includes(device) ? device : "Browser" } });
    await tx.auditLog.create({ data: { actorId: userId, action: "security.session.created", entityType: "Session", entityId: row.id } });
    return { sid: row.id, rotation: row.rotation };
  });
}
export async function validateDeviceSession(userId: string, sid: string, rotation: number) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    const now = new Date(), user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true, isActive: true } });
    if (!user?.isActive) return null;
    const updated = await tx.session.updateMany({ where: { id: sid, userId, rotation, revokedAt: null, expires: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - IDLE_MS) } }, data: { lastSeenAt: now } });
    return updated.count === 1 ? user : null;
  });
}
export async function revokeDeviceSessions(userId: string, sid?: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    // A suspended account may still sign out with its encrypted cookie. Revocation
    // must survive later reactivation; removing access never requires active status.
    if (!await tx.user.count({ where: { id: userId } })) throw new Error("SESSION_UNAVAILABLE");
    const result = await tx.session.updateMany({ where: { userId, ...(sid ? { id: sid } : {}), revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: userId, action: sid ? "security.session.revoked" : "security.sessions.revoked", entityType: "User", entityId: userId, metadata: { count: result.count } } });
    return result.count;
  });
}
export async function rotateDeviceSession(userId: string, sid: string, rotation: number, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isActive || !/^\d{6}$/.test(code) || !(await verifyAuthCode({ email: user.email, code, ip: null, purpose: "SECURITY_STEP_UP" })).ok) throw new Error("REAUTHENTICATION_REQUIRED");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    if (!await tx.user.count({ where: { id: userId, isActive: true } })) throw new Error("SESSION_UNAVAILABLE");
    const now = new Date();
    const changed = await tx.session.updateMany({ where: { id: sid, userId, rotation, revokedAt: null, expires: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - IDLE_MS) } }, data: { rotation: { increment: 1 }, lastSeenAt: now } });
    if (!changed.count) throw new Error("SESSION_UNAVAILABLE");
    await tx.auditLog.create({ data: { actorId: userId, action: "security.session.rotated", entityType: "Session", entityId: sid } });
    return rotation + 1;
  });
}
