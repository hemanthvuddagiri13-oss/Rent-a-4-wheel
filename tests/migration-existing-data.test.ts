import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import path from "path";
import { PrismaClient } from "@prisma/client";

/**
 * Proves the phase1 migration is safe against a database that already has
 * data in the pre-Phase-1 shape — not just a fresh empty database.
 *
 * Sequence: create a throwaway database -> apply the ORIGINAL init
 * migration's raw SQL (the pre-Phase-1 schema) -> insert old-shaped
 * fixture rows (every legacy ReservationStatus value, DriverDocument rows
 * with the old `side` column, a RentalAgreement row) via raw SQL -> mark
 * the init migration as applied in Prisma's own migration table -> run
 * `prisma migrate deploy` for real, exactly as an operator would against
 * a production database -> assert every row survived with the documented
 * mapping.
 *
 * Requires `psql` on PATH and CREATE DATABASE privileges on the
 * DATABASE_URL user (already assumed by the rest of this test suite,
 * which runs integration tests against a real local Postgres instance).
 */

const ROOT = path.resolve(__dirname, "..");
const baseUrl = new URL(process.env.DATABASE_URL || "postgresql://app:app@localhost:5432/rent_a_4wheel");
const testDbName = `migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function adminUrl(databaseName: string): string {
  const url = new URL(baseUrl.toString());
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const testDbUrl = adminUrl(testDbName);
const maintenanceUrl = adminUrl("postgres");

function psql(databaseUrl: string, args: string[]) {
  execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", ...args], { stdio: "inherit" });
}

function prismaCli(args: string[], databaseUrl: string) {
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/prisma/build/index.js"), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

let prisma: PrismaClient;

beforeAll(() => {
  psql(maintenanceUrl, ["-c", `CREATE DATABASE "${testDbName}"`]);
  psql(testDbUrl, ["-f", path.join(ROOT, "prisma/migrations/20260916063629_init/migration.sql")]);
  psql(testDbUrl, ["-f", path.join(ROOT, "tests/fixtures/legacy-schema-seed.sql")]);
  prismaCli(["migrate", "resolve", "--applied", "20260916063629_init"], testDbUrl);
  prismaCli(["migrate", "deploy"], testDbUrl);
  prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  try {
    psql(maintenanceUrl, ["-c", `DROP DATABASE IF EXISTS "${testDbName}"`]);
  } catch {
    // best-effort cleanup
  }
});

describe("migration against a populated pre-Phase-1 database", () => {
  it("preserves captured payments and pending refund identities without issuing new operations", async () => {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: "mig_test_payment" } });
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: "mig_test_refund" } });
    expect(payment.status).toBe("SUCCEEDED"); expect(payment.stripePaymentIntentId).toBe("pi_legacy_fixture");
    expect(refund.status).toBe("PENDING"); expect(refund.stripeRefundId).toBe("re_legacy_fixture");
    expect(refund.idempotencyKey).toBe("legacy-mig_test_refund");
    expect(await prisma.financialOperation.count()).toBe(0);
  });
  it("preserves every legacy reservation row and maps its status correctly", async () => {
    const reservations = await prisma.reservation.findMany({
      where: { id: { startsWith: "mig_test_res_" } },
      select: { id: true, status: true },
      orderBy: { id: "asc" },
    });

    expect(reservations).toHaveLength(5);
    const byId = Object.fromEntries(reservations.map((r) => [r.id, r.status]));
    expect(byId["mig_test_res_pending"]).toBe("AWAITING_PAYMENT");
    expect(byId["mig_test_res_confirmed"]).toBe("CONFIRMED");
    expect(byId["mig_test_res_active"]).toBe("ACTIVE");
    expect(byId["mig_test_res_completed"]).toBe("COMPLETED");
    expect(byId["mig_test_res_cancelled"]).toBe("CANCELLED_BY_CUSTOMER");
  });

  it("preserves every legacy DriverDocument row and maps `side` to `type`", async () => {
    const docs = await prisma.driverDocument.findMany({
      where: { id: { startsWith: "mig_test_doc_" } },
      orderBy: { id: "asc" },
    });

    expect(docs).toHaveLength(2);
    const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
    expect(byId["mig_test_doc_front"].type).toBe("LICENSE_FRONT");
    expect(byId["mig_test_doc_back"].type).toBe("LICENSE_BACK");
    // Backfilled sentinel values, not fabricated real-looking data.
    for (const doc of docs) {
      expect(doc.contentSha256).toBe(`legacy-unmigrated-${doc.id}`);
      expect(doc.fileSizeBytes).toBe(0);
      expect(doc.mimeType).toBe("application/octet-stream");
    }
  });

  it("migrates the legacy RentalAgreement row into AgreementAcceptance without loss", async () => {
    const acceptance = await prisma.agreementAcceptance.findUnique({ where: { id: "mig_test_agreement_1" } });
    expect(acceptance).not.toBeNull();
    expect(acceptance!.type).toBe("RENTAL_AGREEMENT");
    expect(acceptance!.documentVersion).toBe("v1-legacy");
    expect(acceptance!.reservationId).toBe("mig_test_res_confirmed");
    expect(acceptance!.signedByUserId).toBe("mig_test_user_1");
    expect(acceptance!.signerName).toBe("Test User");
  });

  it("drops the old RentalAgreement table after migrating its data", async () => {
    const rows: Array<{ exists: boolean }> = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'RentalAgreement') AS exists`
    );
    expect(rows[0]!.exists).toBe(false);
  });

  it("recreates the status index and the overlap exclusion constraint", async () => {
    const indexes: Array<{ indexname: string }> = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Reservation' AND indexname = 'Reservation_status_idx'`
    );
    expect(indexes).toHaveLength(1);

    const constraints: Array<{ conname: string }> = await prisma.$queryRawUnsafe(
      `SELECT conname FROM pg_constraint WHERE conname = 'reservation_no_overlap_when_blocking'`
    );
    expect(constraints).toHaveLength(1);
  });
});
