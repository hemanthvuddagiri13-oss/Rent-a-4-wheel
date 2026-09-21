import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    sessionId?: string;
    user: {
      id: string;
      role: string;
    } & DefaultSession["user"];
  }

  interface User {
    role?: string;
    sid?: string;
    rotation?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sid?: string;
    rotation?: number;
    id?: string;
    role?: string;
  }
}
