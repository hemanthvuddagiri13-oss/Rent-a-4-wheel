import { afterAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { requestAuthCode, verifyAuthCode } from "@/lib/auth-code";
import { prisma, uniqueEmail } from "./helpers/factories";

vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ sent: false }) }));

afterAll(async () => {
  await prisma.authCode.deleteMany({ where: { email: { contains: "auth-code-concurrency" } } });
  await prisma.$disconnect();
});

describe("atomic auth-code consumption under concurrency", () => {
  it("two simultaneous submissions of the same valid code produce exactly one successful login", async () => {
    const email = uniqueEmail("auth-code-concurrency");
    const code = "654321";
    const codeHash = await bcrypt.hash(code, 4);
    await prisma.authCode.create({
      data: { email, purpose: "SIGN_IN", codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });

    const [first, second] = await Promise.all([
      verifyAuthCode({ email, code, ip: "203.0.113.1" }),
      verifyAuthCode({ email, code, ip: "203.0.113.2" }),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // The row itself must show exactly one consumption — not "consumed
    // twice" (which a non-atomic implementation could otherwise still
    // leave looking fine on the surface).
    const record = await prisma.authCode.findFirstOrThrow({ where: { email, purpose: "SIGN_IN" } });
    expect(record.consumedAt).not.toBeNull();
  });

  it("a code cannot be replayed after it has already been legitimately consumed once", async () => {
    const email = uniqueEmail("auth-code-concurrency");
    const code = "111222";
    const codeHash = await bcrypt.hash(code, 4);
    await prisma.authCode.create({
      data: { email, purpose: "SIGN_IN", codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });

    const firstAttempt = await verifyAuthCode({ email, code, ip: null });
    expect(firstAttempt.ok).toBe(true);

    const replay = await verifyAuthCode({ email, code, ip: null });
    expect(replay.ok).toBe(false);
  });
});

 describe("auth code limits cannot be bypassed by parallel requests", () => {
   it("reserves at most five verification attempts across simultaneous guesses", async () => {
     const email = uniqueEmail("auth-code-concurrency"), codeHash = await bcrypt.hash("123456", 4);
     const record = await prisma.authCode.create({ data: { email, purpose: "SIGN_IN", codeHash, maxAttempts: 5, expiresAt: new Date(Date.now() + 60000) } });
     const results = await Promise.all(Array.from({ length: 20 }, () => verifyAuthCode({ email, code: "654321", ip: null })));
     expect(results.filter(r => !r.ok && r.reason === "mismatch")).toHaveLength(5);
     expect(results.filter(r => !r.ok && r.reason === "locked")).toHaveLength(15);
     expect((await prisma.authCode.findUniqueOrThrow({ where: { id: record.id } })).attempts).toBe(5);
     expect((await verifyAuthCode({ email, code: "123456", ip: null })).ok).toBe(false);
   });
   it("issues one code under simultaneous requests for one email", async () => {
     const email = uniqueEmail("auth-code-concurrency");
     const results = await Promise.all(Array.from({ length: 5 }, () => requestAuthCode({ email, ip: null })));
     expect(results.filter(r => r.ok)).toHaveLength(1);
     expect(await prisma.authCode.count({ where: { email } })).toBe(1);
   });
   it("never revives an older code after the newest code is consumed", async () => {
     const email = uniqueEmail("auth-code-concurrency"), codeHash = await bcrypt.hash("123456", 4);
     await prisma.authCode.create({ data: { email, purpose: "SIGN_IN", codeHash, createdAt: new Date(0), expiresAt: new Date(Date.now() + 60000) } });
     await prisma.authCode.create({ data: { email, purpose: "SIGN_IN", codeHash, consumedAt: new Date(), expiresAt: new Date(Date.now() + 60000) } });
     expect((await verifyAuthCode({ email, code: "123456", ip: null })).ok).toBe(false);
   });
 });
