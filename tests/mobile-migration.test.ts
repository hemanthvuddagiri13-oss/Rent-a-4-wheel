import { beforeAll, afterAll, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const source = new URL(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!);
const name = "mobile_upgrade_" + crypto.randomUUID().replaceAll("-", "") + "_test";
const target = new URL(source); target.pathname = "/" + name;
const admin = new URL(source); admin.pathname = "/postgres";
const db = new PrismaClient({ datasources: { db: { url: target.toString() } } });
const additions = ["20260923000000_mobile_credentials", "20260923001000_mobile_upload_intent"];
function sql(url: URL, args: string[]) { execFileSync(process.env.PSQL_PATH ?? "psql", [url.toString(), "-q", "-v", "ON_ERROR_STOP=1", ...args], { timeout: 120000, stdio: ["ignore", "ignore", "inherit"] }); }
function migrate(name: string) { sql(target, ["-f", path.resolve("prisma/migrations", name, "migration.sql")]); }
beforeAll(() => {
  if (!source.pathname.endsWith("_test")) throw new Error("Disposable database required");
  sql(admin, ["-c", 'CREATE DATABASE "' + name + '"']);
  for (const migration of readdirSync("prisma/migrations").filter(n => /^\d/.test(n) && !additions.includes(n)).sort()) migrate(migration);
}, 120000);
afterAll(async () => { await db.$disconnect(); sql(admin, ["-c", 'DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)']); });
it("upgrades populated web auth and frozen financial evidence without granting native access or releasing holds", async () => {
  const user = await db.user.create({ data: { email: "synthetic-upgrade@mobile.test", customer: { create: {} } } });
  const session = await db.session.create({ data: { userId: user.id, sessionToken: "synthetic-hashed-cookie-locator", expires: new Date("2058-01-01"), rotation: 3 } });
  const authCode = await db.authCode.create({ data: { email: user.email, purpose: "SIGN_IN", codeHash: "synthetic-hash", expiresAt: new Date("2058-01-01"), attempts: 2 } });
  const vehicle = await db.vehicle.create({ data: { slug: "mobile-upgrade", vin: "mobile-upgrade", licensePlate: "SYNTHETIC", year: 2024, make: "Synthetic", model: "Fixture", category: "SEDAN", dailyRateCents: 10000, weeklyRateCents: 50000, monthlyRateCents: 100000 } });
  const reservation = await db.reservation.create({ data: { confirmationNumber: "SYNTHETIC-UPGRADE", customerId: user.id, vehicleId: vehicle.id, status: "COMPLETED", financialDisposition: "REVIEW", pickupAt: new Date("2055-01-01"), returnAt: new Date("2055-01-02"), rateType: "DAILY", rateAmountCents: 10000, units: 1, subtotalCents: 10000, totalCents: 10000 } });
  const payment = await db.payment.create({ data: { reservationId: reservation.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 10000 } });
  const issue = await db.financeIssue.create({ data: { key: "synthetic-held-upgrade", reservationId: reservation.id, kind: "ALLOCATION_REQUIRED", reason: "Existing immutable historical allocation review" } });
  const quote = await db.financeQuote.create({ data: { reservationId: reservation.id, terms: { approved: false, amounts: { totalCents: 10000 }, immutableFixture: true } } });
  for (const migration of additions) migrate(migration);
  expect(await db.user.findUnique({ where: { id: user.id } })).toEqual(user);
  expect(await db.session.findMany()).toEqual([session]); expect(await db.authCode.findMany()).toEqual([authCode]);
  expect(await db.reservation.findMany()).toEqual([reservation]); expect(await db.payment.findMany()).toEqual([payment]);
  expect(await db.financeIssue.findMany()).toEqual([issue]); expect(await db.financeQuote.findMany()).toEqual([quote]);
  expect(await db.mobileSession.count()).toBe(0); expect(await db.mobileCredential.count()).toBe(0); expect(await db.mobileMutation.count()).toBe(0); expect(await db.mobileUpload.count()).toBe(0);
  expect(await db.payoutBatch.count()).toBe(0); expect(await db.ledgerJournal.count()).toBe(0);
  const code = await db.authCode.create({ data: { email: user.email, purpose: "MOBILE_SIGN_IN", codeHash: "synthetic-mobile-hash", expiresAt: new Date("2058-01-01") } }); expect(code.purpose).toBe("MOBILE_SIGN_IN");
}, 120000);
