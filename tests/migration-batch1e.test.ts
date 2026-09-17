import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
const boundary = vi.hoisted(() => ({ db: null as unknown as PrismaClient, retrieve: vi.fn() }));
// The service uses an actual isolated PostgreSQL database. Only Stripe is fake.
vi.mock("@/lib/prisma", () => ({ get prisma() { return boundary.db; } }));
vi.mock("@/lib/stripe", () => ({ stripe: { paymentIntents: { retrieve: boundary.retrieve } } }));
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
const root = path.resolve(__dirname, ".."), cutoff = "20260918010000_financial_quarantine_and_booking_zone";
const migrations = readdirSync(path.join(root, "prisma/migrations")).filter(s => /^\d/.test(s)).sort();
function url(name: string) { const u = new URL(process.env.DATABASE_URL!); u.pathname = "/" + name; return u.toString(); }
function sql(db: string, args: string[]) { execFileSync("psql", [db, "-v", "ON_ERROR_STOP=1", ...args], { stdio: "inherit" }); }
describe("Batch 1D populated data repaired by additive Batch 1E migration", () => {
  it("repairs release and legacy authorization cases and verifies/settles through the real service", async () => {
    const name = "batch1e_" + Date.now(), db = url(name); sql(url("postgres"), ["-c", `CREATE DATABASE "${name}"`]);
    const client = new PrismaClient({ datasources: { db: { url: db } } }); boundary.db = client;
    try {
      for (const migration of migrations.filter(m => m <= cutoff)) {
        sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
        if (migration.endsWith("_init")) sql(db, ["-f", path.join(root, "tests/fixtures/legacy-schema-seed.sql")]);
      }
      sql(db, ["-c", `UPDATE "User" SET "stripeCustomerId"='cus_original' WHERE "id"='mig_test_user_1';
        UPDATE "User" SET "role"='SUPER_ADMIN' WHERE "id"='mig_test_user_2';
        UPDATE "Refund" SET "status"='SUCCEEDED' WHERE "id"='mig_test_refund';
        UPDATE "Reservation" SET "depositCents"=30000,"financialDisposition"='REVIEW' WHERE "id"='mig_test_res_confirmed';
        INSERT INTO "FinancialOperation" ("id","key","kind","reservationId","fingerprint","payload","providerId","state","generation","updatedAt") VALUES
        ('original-auth','original-auth-key','DEPOSIT','mig_test_res_confirmed','legacy','{"legacy":true}','pi_original_auth','REVIEW',1,now()),
        ('original-release','deposit-release:pi_original_auth','DEPOSIT_RELEASE','mig_test_res_confirmed','release','{"intentId":"pi_original_auth"}',NULL,'REVIEW',NULL,now()),
        ('unknown-auth','unknown-auth-key','DEPOSIT','mig_test_res_completed','unknown','{"legacy":true}',NULL,'REVIEW',NULL,now());
        INSERT INTO "SecurityDeposit" ("id","reservationId","amountCents","operationId","stripePaymentIntentId","generation","legacyUncertain","updatedAt") VALUES ('original-deposit','mig_test_res_confirmed',30000,'original-auth','pi_original_auth',1,true,now());
        INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","operationId","kind","amountCents","originalKey","reason","updatedAt") VALUES
        ('auth-case','operation:original-auth','mig_test_res_confirmed','mig_test_user_1','original-auth','DEPOSIT',0,'original-auth-key','Original review',now()),
        ('release-case','operation:original-release','mig_test_res_confirmed','mig_test_user_1','original-release','DEPOSIT_RELEASE',0,'deposit-release:pi_original_auth','Original review',now()),
        ('unknown-case','operation:unknown-auth','mig_test_res_completed','mig_test_user_1','unknown-auth','DEPOSIT',0,'unknown-auth-key','Unknown evidence',now());
        INSERT INTO "AuditLog" ("id","actorId","action","entityType","entityId","metadata") VALUES ('original-audit','mig_test_user_2','financial-case.escalate','FinancialCase','release-case','{"reason":"original investigation"}');`]);
      const before = await client.$queryRaw<Array<{ amountCents: number }>>`SELECT "amountCents" FROM "FinancialCase" WHERE "id"='release-case'`; expect(before[0].amountCents).toBe(0);
      for (const migration of migrations.filter(m => m > cutoff)) sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
      for (const id of ["auth-case", "release-case"]) expect(await client.financialCase.findUniqueOrThrow({ where: { id } })).toMatchObject({ amountCents: 30000, currency: "usd", status: "OPEN" });
      expect(await client.financialCase.findUniqueOrThrow({ where: { id: "unknown-case" } })).toMatchObject({ amountCents: null, currency: null });
      const actor = { id: "mig_test_user_2", role: "SUPER_ADMIN" }, evidence = { id: "pi_original_auth", amount: 30000, amount_capturable: 0, currency: "usd", customer: "cus_original", status: "canceled", capture_method: "manual", metadata: { reservationId: "mig_test_res_confirmed", purpose: "security_deposit", operationKey: "original-auth-key" } };
      boundary.retrieve.mockResolvedValue({ ...evidence, amount: 1 });
      await expect(resolveFinancialCase(actor, { caseId: "release-case", action: "ADOPT", providerId: evidence.id, reason: "Mismatched authorization amount must fail" })).rejects.toThrow("amount");
      boundary.retrieve.mockResolvedValue(evidence);
      for (const caseId of ["auth-case", "release-case"]) await resolveFinancialCase(actor, { caseId, action: "ADOPT", providerId: evidence.id, reason: "Original authorization verified against provider ledger" });
      expect(await client.financialCase.count({ where: { id: { in: ["auth-case", "release-case"] }, status: "VERIFIED" } })).toBe(2);
      expect(await client.financialOperation.count({ where: { kind: { in: ["DEPOSIT", "DEPOSIT_RELEASE"] } } })).toBe(3);
      await resolveFinancialCase(actor, { caseId: "release-case", action: "AUTHORIZE_SETTLEMENT", reason: "Authorize remaining rental refund after evidence verification" });
      expect(await client.refund.count({ where: { reservationId: "mig_test_res_confirmed", amountCents: 10000, status: "PENDING" } })).toBe(1);
      expect(await client.auditLog.findUnique({ where: { id: "original-audit" } })).not.toBeNull();
      expect((await client.financialCase.findUniqueOrThrow({ where: { id: "release-case" } })).status).toBe("RESOLVED");
    } finally { await client.$disconnect(); sql(url("postgres"), ["-c", `DROP DATABASE "${name}"`]); }
  }, 120000);
});
