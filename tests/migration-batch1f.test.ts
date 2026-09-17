import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
const boundary = vi.hoisted(() => ({ db: null as unknown as PrismaClient, intents: vi.fn(), refunds: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return boundary.db; } }));
vi.mock("@/lib/stripe", () => ({ stripe: { paymentIntents: { retrieve: boundary.intents }, refunds: { create: boundary.refunds } } }));
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
import { executeRefundOperation } from "@/lib/refund-operations";
const root = path.resolve(__dirname, ".."), beforeCases = "20260917010000_financial_recovery_generations", beforeRepair = "20260918010000_financial_quarantine_and_booking_zone";
const migrations = readdirSync(path.join(root, "prisma/migrations")).filter(s => /^\d/.test(s)).sort();
function url(name: string) { const u = new URL(process.env.DATABASE_URL!); u.pathname = "/" + name; return u.toString(); }
function sql(db: string, args: string[]) { execFileSync("psql", [db, "-v", "ON_ERROR_STOP=1", ...args], { stdio: "inherit" }); }
describe("migration-generated reservation-level reconciliation", () => {
  it("links the existing rental evidence, preserves audit history and settles through real services", async () => {
    const name = "batch1f_" + Date.now(), db = url(name); sql(url("postgres"), ["-c", `CREATE DATABASE "${name}"`]);
    const client = new PrismaClient({ datasources: { db: { url: db } } }); boundary.db = client;
    try {
      for (const migration of migrations.filter(m => m <= beforeCases)) {
        sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
        if (migration.endsWith("_init")) sql(db, ["-f", path.join(root, "tests/fixtures/legacy-schema-seed.sql")]);
      }
      sql(db, ["-c", `UPDATE "User" SET "stripeCustomerId"='cus_original' WHERE "id"='mig_test_user_1';
        UPDATE "User" SET "role"='SUPER_ADMIN' WHERE "id"='mig_test_user_2';
        UPDATE "Refund" SET "status"='SUCCEEDED' WHERE "id"='mig_test_refund';
        UPDATE "Payment" SET "idempotencyKey"='original-rental-key',"currency"='eur' WHERE "id"='mig_test_payment';
        UPDATE "Reservation" SET "financialDisposition"='REVIEW' WHERE "id"='mig_test_res_confirmed';
        INSERT INTO "FinancialOperation" ("id","key","kind","reservationId","fingerprint","payload","providerId","state","updatedAt") VALUES
        ('original-rental','original-rental-key','RENTAL','mig_test_res_confirmed','original','{"amount":15000,"currency":"eur","customer":"cus_original","metadata":{"reservationId":"mig_test_res_confirmed","paymentId":"mig_test_payment"}}','pi_legacy_fixture','OBSERVED',now());`]);
      // The real preceding migration generates the case; the test never inserts it.
      for (const migration of migrations.filter(m => m > beforeCases && m <= beforeRepair)) sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
      const generated = await client.$queryRaw<Array<{ id: string; reason: string; paymentId: string | null; operationId: string | null }>>`SELECT "id","reason","paymentId","operationId" FROM "FinancialCase" WHERE "reservationId"='mig_test_res_confirmed'`;
      expect(generated).toEqual([{ id: "case-reservation-mig_test_res_confirmed", reason: "LEGACY_RESERVATION_REVIEW", paymentId: null, operationId: null }]);
      sql(db, ["-c", `INSERT INTO "AuditLog" ("id","actorId","action","entityType","entityId","metadata") VALUES ('original-audit','mig_test_user_2','financial-case.escalate','FinancialCase','${generated[0].id}','{"reason":"original investigation"}');`]);
      for (const migration of migrations.filter(m => m > beforeRepair)) sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
      const c = await client.financialCase.findUniqueOrThrow({ where: { id: generated[0].id } }), actor = { id: "mig_test_user_2", role: "SUPER_ADMIN" };
      expect(c).toMatchObject({ paymentId: null, operationId: null, originalKey: null, providerId: null, amountCents: null, currency: null });
      const audit = await client.auditLog.findUniqueOrThrow({ where: { id: "original-audit" } });
      const ownershipCount = await client.providerObjectOwnership.count(), operationCount = await client.financialOperation.count();
      const evidence = { id: "pi_legacy_fixture", amount: 15000, currency: "eur", customer: "cus_original", status: "succeeded", capture_method: "automatic", metadata: { reservationId: c.reservationId, paymentId: "mig_test_payment", operationKey: "original-rental-key" } };
      const adopt = () => resolveFinancialCase(actor, { caseId: c.id, action: "ADOPT", providerId: evidence.id, reason: "Verify original rental provider and immutable operation evidence" });
      for (const bad of [{ amount: 1 }, { currency: "usd" }, { customer: "cus_wrong" }, { capture_method: "manual", metadata: { ...evidence.metadata, purpose: "security_deposit" } }]) {
        boundary.intents.mockResolvedValue({ ...evidence, ...bad }); await expect(adopt()).rejects.toThrow();
        expect(await client.financialCase.findUniqueOrThrow({ where: { id: c.id } })).toEqual(c);
      }
      // A conflicting original-key operation makes the evidence ambiguous even
      // though the supplied Stripe ID itself has a unique ownership row.
      await client.financialOperation.create({ data: { id: "conflicting-operation", key: "conflicting-key", kind: "RENTAL", reservationId: c.reservationId, fingerprint: "conflict", payload: {}, state: "REVIEW" } });
      boundary.intents.mockResolvedValue({ ...evidence, metadata: { ...evidence.metadata, operationKey: "conflicting-key" } });
      await expect(adopt()).rejects.toThrow("Ambiguous legacy rental operation evidence");
      await client.financialOperation.delete({ where: { id: "conflicting-operation" } });
      boundary.intents.mockResolvedValue(evidence); await adopt();
      expect(await client.financialCase.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ paymentId: "mig_test_payment", operationId: "original-rental", providerId: evidence.id, originalKey: "original-rental-key", amountCents: 15000, currency: "eur", status: "VERIFIED" });
      expect(await client.financialOperation.count()).toBe(operationCount); expect(await client.providerObjectOwnership.count()).toBe(ownershipCount);
      expect(await client.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).toEqual(audit);
      expect((await client.reservation.findUniqueOrThrow({ where: { id: c.reservationId } })).financialDisposition).toBe("REVIEW");
      await resolveFinancialCase(actor, { caseId: c.id, action: "AUTHORIZE_SETTLEMENT", reason: "Authorize remaining rental refund after verified evidence" });
      const pending = await client.refund.findFirstOrThrow({ where: { reservationId: c.reservationId, status: "PENDING" } }); expect(pending.amountCents).toBe(10000);
      expect((await client.reservation.findUniqueOrThrow({ where: { id: c.reservationId } })).status).toBe("CONFIRMED");
      boundary.refunds.mockResolvedValue({ id: "re_settlement", status: "succeeded", amount: 10000, currency: "eur", payment_intent: evidence.id });
      await executeRefundOperation(pending.id, evidence.id);
      expect(await client.reservation.findUniqueOrThrow({ where: { id: c.reservationId } })).toMatchObject({ status: "EXPIRED", financialDisposition: "TERMINATED" });
      expect(await client.financialOperation.count({ where: { kind: "RENTAL" } })).toBe(1);
      expect(await client.providerObjectOwnership.count({ where: { providerId: evidence.id } })).toBe(1);
      expect(await client.auditLog.count({ where: { entityId: c.id } })).toBe(3);
    } finally { await client.$disconnect(); sql(url("postgres"), ["-c", `DROP DATABASE "${name}"`]); }
  }, 120000);
});
