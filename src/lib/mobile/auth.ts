import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { verifyAuthCode } from "@/lib/auth-code";
import type { DomainDatabase } from "@/lib/domain-transaction";

export class MobileError extends Error {
  constructor(public code: "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_REQUEST" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "UNAVAILABLE", public status: number) { super(code); }
}
export const mobileDeviceSchema = z.object({
  deviceId: z.uuid(), platform: z.enum(["IOS", "ANDROID"]),
  appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
}).strict();
export const mobileSignInSchema = mobileDeviceSchema.extend({ email: z.email().max(254).transform(s => s.trim().toLowerCase()), code: z.string().regex(/^\d{6}$/) });
const ACCESS_MS = 5 * 60_000, REFRESH_MS = 7 * 86400_000, FAMILY_MS = 30 * 86400_000;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = (kind: "ma" | "mr") => `${kind}_${randomBytes(32).toString("base64url")}`;
const validToken = (token: string, kind: "ma" | "mr") => new RegExp(`^${kind}_[A-Za-z0-9_-]{43}$`).test(token);
async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
  return tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true } });
}
function nativeRole(role: string) { return ["CUSTOMER", "HOST", "HOST_EMPLOYEE"].includes(role); }
async function audit(tx: Prisma.TransactionClient, userId: string, sessionId: string, action: string) {
  await tx.auditLog.create({ data: { actorId: userId, entityType: "MobileSession", entityId: sessionId, action } });
}
async function issue(tx: Prisma.TransactionClient, sessionId: string, generation: number, familyExpires: Date) {
  const accessToken = newToken("ma"), refreshToken = newToken("mr");
  const accessExpiresAt = new Date(Math.min(Date.now() + ACCESS_MS, familyExpires.getTime()));
  const refreshExpiresAt = new Date(Math.min(Date.now() + REFRESH_MS, familyExpires.getTime()));
  await tx.mobileCredential.create({ data: { sessionId, generation, accessHash: tokenHash(accessToken), refreshHash: tokenHash(refreshToken), accessExpiresAt, refreshExpiresAt } });
  return { tokenType: "Bearer" as const, accessToken, refreshToken, accessExpiresAt: accessExpiresAt.toISOString(), refreshExpiresAt: refreshExpiresAt.toISOString(), sessionId };
}

export async function mobileSignIn(input: unknown, ip: string, db: PrismaClient = prisma) {
  const data = mobileSignInSchema.parse(input);
  const verified = await verifyAuthCode({ email: data.email, code: data.code, ip, purpose: "MOBILE_SIGN_IN" });
  if (!verified.ok) throw new MobileError("UNAUTHORIZED", 401);
  return db.$transaction(async tx => {
    // Upsert is safe against simultaneous web/native first sign-in. Never alter
    // an existing account's role or reactivate an inactive account.
    const user = await tx.user.upsert({ where: { email: data.email }, update: {}, create: { email: data.email, emailVerified: new Date(), customer: { create: {} } } });
    const current = await lockUser(tx, user.id);
    if (!current?.isActive || !nativeRole(current.role)) throw new MobileError("UNAUTHORIZED", 401);
    await tx.mobileSession.updateMany({ where: { userId: user.id, deviceId: data.deviceId, revokedAt: null }, data: { revokedAt: new Date(), revocationReason: "REAUTHENTICATED" } });
    const session = await tx.mobileSession.create({ data: { userId: user.id, deviceId: data.deviceId, platform: data.platform, appVersion: data.appVersion, expiresAt: new Date(Date.now() + FAMILY_MS) } });
    await audit(tx, user.id, session.id, "mobile.signed_in");
    return issue(tx, session.id, 0, session.expiresAt);
  });
}

export async function refreshMobileCredential(token: string, db: PrismaClient = prisma) {
  if (!validToken(token, "mr")) throw new MobileError("UNAUTHORIZED", 401);
  const hash = tokenHash(token);
  const locator = await db.mobileCredential.findUnique({ where: { refreshHash: hash }, select: { session: { select: { userId: true } } } });
  if (!locator) throw new MobileError("UNAUTHORIZED", 401);
  const result = await db.$transaction(async tx => {
    const user = await lockUser(tx, locator.session.userId);
    const credential = await tx.mobileCredential.findUniqueOrThrow({ where: { refreshHash: hash }, include: { session: true } });
    const session = credential.session;
    if (session.revokedAt) return null;
    if (credential.consumedAt || credential.generation !== session.generation) {
      await tx.mobileSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revocationReason: "REFRESH_REUSE", reuseDetectedAt: new Date() } });
      await audit(tx, session.userId, session.id, "mobile.refresh_reuse");
      return null; // Commit family revocation before reporting authentication failure.
    }
    if (!user?.isActive || !nativeRole(user.role) || session.expiresAt <= new Date() || credential.refreshExpiresAt <= new Date()) {
      await tx.mobileSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revocationReason: "INELIGIBLE_OR_EXPIRED" } });
      await audit(tx, session.userId, session.id, "mobile.refresh_denied");
      return null;
    }
    await tx.mobileCredential.update({ where: { id: credential.id }, data: { consumedAt: new Date() } });
    await tx.mobileSession.update({ where: { id: session.id }, data: { generation: { increment: 1 }, lastUsedAt: new Date() } });
    await audit(tx, session.userId, session.id, "mobile.refreshed");
    return issue(tx, session.id, session.generation + 1, session.expiresAt);
  });
  if (!result) throw new MobileError("UNAUTHORIZED", 401);
  return result;
}

export async function authenticateMobile(headers: Headers, db: DomainDatabase = prisma) {
  // This namespace never falls back to cookie authentication.
  const authorization = headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!validToken(token, "ma")) throw new MobileError("UNAUTHORIZED", 401);
  const credential = await db.mobileCredential.findUnique({ where: { accessHash: tokenHash(token) }, include: { session: { include: { user: { select: { id: true, role: true, isActive: true } } } } } });
  if (!credential || credential.consumedAt || credential.accessExpiresAt <= new Date()) throw new MobileError("UNAUTHORIZED", 401);
  const { session } = credential;
  if (session.revokedAt || session.expiresAt <= new Date() || credential.generation !== session.generation || !session.user.isActive || !nativeRole(session.user.role)) throw new MobileError("UNAUTHORIZED", 401);
  const accepted = await db.mobileSession.updateMany({ where: { id: session.id, generation: credential.generation, revokedAt: null, expiresAt: { gt: new Date() }, user: { isActive: true, role: { in: ["CUSTOMER", "HOST", "HOST_EMPLOYEE"] } }, credentials: { some: { id: credential.id, consumedAt: null, accessExpiresAt: { gt: new Date() } } } }, data: { lastUsedAt: new Date() } });
  if (accepted.count !== 1) throw new MobileError("UNAUTHORIZED", 401);
  return { userId: session.userId, sessionId: session.id, role: session.user.role };
}

export async function revokeMobileSessions(userId: string, sessionId?: string, db: PrismaClient = prisma) {
  return db.$transaction(async tx => {
    await lockUser(tx, userId);
    if (sessionId && !await tx.mobileSession.findFirst({ where: { id: sessionId, userId } })) throw new MobileError("NOT_FOUND", 404);
    await tx.mobileSession.updateMany({ where: { userId, ...(sessionId ? { id: sessionId } : {}), revokedAt: null }, data: { revokedAt: new Date(), revocationReason: "LOGOUT" } });
    await audit(tx, userId, sessionId ?? userId, sessionId ? "mobile.logout" : "mobile.logout_all");
    return { revoked: true };
  });
}
