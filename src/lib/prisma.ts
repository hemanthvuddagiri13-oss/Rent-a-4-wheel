import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export function createSafePrismaClient(url?: string): PrismaClient {
  return new PrismaClient({
    log: [], // Prisma exception formatting includes invocation arguments and PII.
    ...(url ? { datasources: { db: { url } } } : {}),
  }).$extends({ query: { $allOperations: async ({ args, query }) => {
    try { return await query(args); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) throw new Prisma.PrismaClientKnownRequestError("DATABASE_OPERATION_FAILED", { code: error.code, clientVersion: error.clientVersion });
      throw new Error("DATABASE_OPERATION_FAILED");
    }
  } } }) as unknown as PrismaClient;
}
export const prisma = globalForPrisma.prisma ?? createSafePrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
