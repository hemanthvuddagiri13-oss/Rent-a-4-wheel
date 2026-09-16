import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { verifyAuthCode, getRequestIp } from "@/lib/auth-code";
import { authConfig } from "@/auth.config";
import { safeLog } from "@/lib/safe-log";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  logger: { error: error => safeLog("AUTH_FAILED", error), warn: () => safeLog("AUTH_WARNING"), debug: () => {} },
  session: { strategy: "jwt" },
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

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
});
