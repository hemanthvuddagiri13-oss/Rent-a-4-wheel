import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe auth config (no Prisma/bcrypt imports) used by middleware.
 * The full config with the Credentials provider lives in `src/auth.ts`.
 */
export const authConfig = {
  pages: { signIn: "/sign-in" },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as { role?: string }).role;
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
