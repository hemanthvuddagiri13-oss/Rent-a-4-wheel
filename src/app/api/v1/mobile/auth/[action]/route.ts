import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requestAuthCode } from "@/lib/auth-code";
import { authenticateMobile, MobileError, mobileSignIn, refreshMobileCredential, revokeMobileSessions } from "@/lib/mobile/auth";
import { mobileBody, mobileHandler, mobileIp } from "@/lib/mobile/http";

const actions = ["request-code", "sign-in", "refresh", "logout", "logout-all", "revoke"] as const;
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  return mobileHandler(req, actions.includes(action as typeof actions[number]) ? `auth.${action}` : "auth.unknown", async () => {
    if (!actions.includes(action as typeof actions[number])) throw new MobileError("NOT_FOUND", 404);
    const input = await mobileBody(req);
    if (action === "request-code") {
      const { email } = z.object({ email: z.email().max(254) }).strict().parse(input);
      // Same response for unknown, existing, disabled and throttled accounts.
      const issued = await requestAuthCode({ email, ip: mobileIp(req.headers), purpose: "MOBILE_SIGN_IN" });
      if (!issued.ok) await prisma.auditLog.create({ data: { action: "mobile.code_throttled", entityType: "MobileAuthentication", entityId: mobileIp(req.headers), metadata: { reason: issued.reason } } });
      return { accepted: true };
    }
    if (action === "sign-in") return mobileSignIn(input, mobileIp(req.headers));
    if (action === "refresh") return refreshMobileCredential(z.object({ refreshToken: z.string().max(100) }).strict().parse(input).refreshToken);
    const actor = await authenticateMobile(req.headers);
    if (action === "revoke") return revokeMobileSessions(actor.userId, z.object({ sessionId: z.string().max(128) }).strict().parse(input).sessionId);
    z.object({}).strict().parse(input);
    return revokeMobileSessions(actor.userId, action === "logout" ? actor.sessionId : undefined);
  });
}
export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  return mobileHandler(req, "auth.devices", async () => {
    if (action !== "devices") throw new MobileError("NOT_FOUND", 404);
    const actor = await authenticateMobile(req.headers);
    return { devices: await prisma.mobileSession.findMany({ where: { userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, platform: true, appVersion: true, lastUsedAt: true, expiresAt: true } }) };
  });
}
