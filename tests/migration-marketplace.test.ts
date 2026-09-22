import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

it("upgrades populated Phase 1 inventory without changing payments or signed evidence", async () => {
  const name = `marketplace_upgrade_${Date.now()}`, admin = new URL(process.env.DATABASE_URL!), target = new URL(admin);
  admin.pathname = "/postgres"; target.pathname = "/" + name;
  const sql = (url: string, args: string[]) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...args], { stdio: "inherit" });
  sql(admin.toString(), ["-c", `CREATE DATABASE "${name}"`]);
  const db = new PrismaClient({ datasources: { db: { url: target.toString() } } });
  const migrations = readdirSync("prisma/migrations").filter(s => /^\d/.test(s)).sort();
  try {
    for (const migration of migrations.filter(m => m < "20260921010000")) {
      sql(target.toString(), ["-f", path.resolve("prisma/migrations", migration, "migration.sql")]);
      if (migration.endsWith("_init")) sql(target.toString(), ["-f", path.resolve("tests/fixtures/legacy-schema-seed.sql")]);
    }
    const before = await db.$queryRaw`SELECT "id","status","totalCents","financialDisposition" FROM "Reservation" ORDER BY "id"`;
    const payments = await db.payment.findMany({ orderBy: { id: "asc" } });
    const owner = await db.user.create({ data: { email: "legacy-host@migration.test", role: "HOST" } });
    const employee = await db.user.create({ data: { email: "legacy-manager@migration.test", role: "HOST_EMPLOYEE" } });
    const host = await db.hostProfile.create({ select:{id:true}, data: { userId: owner.id, legalName: "Legacy host" } });
    await db.$executeRaw`INSERT INTO "HostEmployee" ("id","hostId","userId","role") VALUES ('legacy-membership',${host.id},${employee.id},'MANAGER')`;
    for (const migration of migrations.filter(m => m >= "20260921010000")) sql(target.toString(), ["-f", path.resolve("prisma/migrations", migration, "migration.sql")]);
    expect(await db.$queryRaw`SELECT "id","status","totalCents","financialDisposition" FROM "Reservation" ORDER BY "id"`).toEqual(before);
    expect(await db.payment.findMany({ orderBy: { id: "asc" } })).toEqual(payments);
    const vehicles = await db.vehicle.findMany();
    expect(vehicles.length).toBeGreaterThan(0);
    for (const vehicle of vehicles) expect(vehicle).toMatchObject({ listingApproval: "APPROVED", listingRevision: 1, location: "Dallas, TX" });
    expect(await db.marketplaceFile.count()).toBe(0);
    expect(await db.hostEmployee.findUnique({ where: { id: "legacy-membership" } })).toMatchObject({ userId: employee.id, hostId: host.id, role: "MANAGER", isActive: true, expiresAt: null });
  } finally { await db.$disconnect(); sql(admin.toString(), ["-c", `DROP DATABASE "${name}"`]); }
}, 120000);
