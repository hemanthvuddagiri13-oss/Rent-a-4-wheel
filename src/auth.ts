import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { verifyAuthCode, getRequestIp } from "@/lib/auth-code";
import { authConfig } from "@/auth.config";
import { safeLog } from "@/lib/safe-log";
import { createDeviceSession, validateDeviceSession, rotateDeviceSession } from "@/lib/device-sessions";
import { localDevelopment } from "@/lib/deployment-environment";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  logger: { error: error => safeLog("AUTH_FAILED", error), warn: () => safeLog("AUTH_WARNING"), debug: () => {} },
  // Encrypted cookie is only a locator. The database authorizes every request.
  session: { strategy: "jwt", maxAge: 7 * 86400 },
  useSecureCookies: !localDevelopment(),
  callbacks: {
    ...authConfig.callbacks,
    async jwt(params) {
      const token = await authConfig.callbacks.jwt(params);
      if (params.user) { token.sid = params.user.sid; token.rotation = params.user.rotation; }
      if (params.trigger === "update" && params.session?.action === "rotate" && token.id && token.sid && typeof token.rotation === "number") {
        token.rotation = await rotateDeviceSession(token.id, token.sid, token.rotation, String(params.session.code ?? ""));
      }
      return token;
    },
    async session(params) {
      const session = await authConfig.callbacks.session(params);
      const current = session.user?.id && params.token.sid && typeof params.token.rotation === "number" ? await validateDeviceSession(session.user.id, params.token.sid, params.token.rotation) : null;
      if (!current?.isActive) session.user = undefined as never;
      else Object.assign(session.user, { id: current.id, role: current.role, email: current.email, name: current.name });
      session.sessionId = current ? params.token.sid : undefined;
      session.credentialVersion = current ? params.token.rotation : undefined;
      return session;
    },
  },
  providers: [
    Credentials({
      id: "email-code",
      name: "Email code",
      credentials: {
        email: { label: "Email", type: "email" },
        code: { label: "Code", type: "text" },
      },
      async authorize(credentials, request) {
        const email = credentials?.email as string | undefined;
        const code = credentials?.code as string | undefined;
        if (!email || !code) return null;

        const ip = getRequestIp(request.headers);
        const result = await verifyAuthCode({ email, code, ip });
        if (!result.ok) return null;

        const normalizedEmail = email.trim().toLowerCase();
        let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

        if (!user) {
          user = await prisma.user.create({
            data: {
              email: normalizedEmail,
              role: "CUSTOMER",
              emailVerified: new Date(),
              customer: { create: {} },
            },
          });
        } else if (!user.emailVerified) {
          user = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
        }

        if (!user.isActive) return null;

        await prisma.auditLog.create({
          data: { actorId: user.id, action: "auth.signed_in", entityType: "User", entityId: user.id, metadata: { ip } },
        });

        const device = await createDeviceSession(user.id, /Mobile|Android|iPhone/.test(request.headers.get("user-agent") ?? "") ? "Mobile browser" : "Browser");
        return { id: user.id, email: user.email, name: user.name, role: user.role, ...device };
      },
    }),
  ],
});
