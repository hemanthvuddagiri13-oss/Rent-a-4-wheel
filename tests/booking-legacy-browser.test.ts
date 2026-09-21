import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { encode } from "next-auth/jwt";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { fingerprint } from "@/lib/financial-operations";
const root = path.resolve(__dirname, ".."), cutoff = "20260917010000_financial_recovery_generations";
function url(name: string) { const u = new URL(process.env.DATABASE_URL!); u.pathname = "/" + name; return u.toString(); }
function sql(db: string, args: string[]) { execFileSync("psql", [db, "-v", "ON_ERROR_STOP=1", ...args], { stdio: "inherit" }); }
describe("previous schema checkout resumed by real Next/PostgreSQL/Chromium", () => {
  it("upgrades only unfinished identities, preserves selections/prices/UTC instants and reuses the hold", async () => {
    const name = "legacy_browser_" + Date.now(), db = url(name), base = "http://127.0.0.1:3199", secret = "legacy-browser-test-isolated-secret";
    sql(url("postgres"), ["-c", `CREATE DATABASE "${name}"`]);
    const client = new PrismaClient({ datasources: { db: { url: db } } }); let child: ChildProcess | undefined, browser: Browser | undefined;
    try {
      const migrations = readdirSync(path.join(root, "prisma/migrations")).filter(s => /^\d/.test(s)).sort();
      for (const migration of migrations.filter(m => m <= cutoff)) {
        sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
        if (migration.endsWith("_init")) sql(db, ["-f", path.join(root, "tests/fixtures/legacy-schema-seed.sql")]);
      }
      const draftId = randomUUID(), id = "mig_test_res_pending", vehicleId = "mig_test_vehicle_1", customerId = "mig_test_user_1";
      const pickupAt = new Date("2030-03-09T16:00:00Z"), returnAt = new Date("2030-03-12T15:00:00Z");
      const old = fingerprint({ customerId, vehicleId, pickupAt, returnAt, extraIds: ["legacy-extra"], couponCode: "LEGACY10" });
      sql(db, ["-c", `INSERT INTO "Extra" ("id","name","chargeType","amountCents","updatedAt") VALUES ('legacy-extra','Legacy child seat','ONE_TIME',1200,now());
        INSERT INTO "Coupon" ("id","code","discountType","amountCents","startsAt","expiresAt","isActive","applicableVehicleIds","updatedAt") VALUES ('legacy-coupon','LEGACY10','FIXED',1000,'2020-01-01','2040-01-01',true,'{}',now());
        UPDATE "Reservation" SET "pickupAt"='2030-03-09 16:00:00',"returnAt"='2030-03-12 15:00:00',"status"='CHECKOUT_HOLD',"expiresAt"=now()+interval '1 hour',"bookingFingerprint"='${old}',"couponId"='legacy-coupon',"extrasCents"=1200,"discountCents"=1000,"taxCents"=1254,"totalCents"=16454 WHERE "id"='${id}';
        INSERT INTO "ReservationExtra" ("id","reservationId","extraId","quantity","amountCents") VALUES ('legacy-line','${id}','legacy-extra',1,1200);
        INSERT INTO "BookingDraft" ("id","customerId","vehicleId","reservationId","revision","fingerprint","updatedAt") VALUES ('${draftId}','${customerId}','${vehicleId}','${id}',7,'${old}',now());
        UPDATE "Reservation" SET "bookingFingerprint"='finalized-original',"checkoutFingerprint"='finalized-checkout' WHERE "id"='mig_test_res_confirmed';`]);
      // These records really existed before either timezone or version columns.
      for (const migration of migrations.filter(m => m > cutoff)) sql(db, ["-f", path.join(root, "prisma/migrations", migration, "migration.sql")]);
      const before = await client.reservation.findUniqueOrThrow({ where: { id }, include: { extras: true, payments: true } });
      const finalized = await client.reservation.findUniqueOrThrow({ where: { id: "mig_test_res_confirmed" } });
      expect(before.bookingFingerprintVersion).toBe(1); expect(before.bookingFingerprint).toBe(old);
      child = spawn(process.execPath, ["tests/helpers/app-server.mjs"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: db, NODE_ENV: "development", TZ: "Asia/Tokyo", AUTH_SECRET: secret, AUTH_TRUST_HOST: "true", NEXTAUTH_URL: base, AUTH_URL: base, STRIPE_SECRET_KEY: "", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "", STRIPE_WEBHOOK_SECRET: "", ALLOW_DEV_PAYMENT_SIMULATION: "true", ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV: "true" } });
      const deadline = Date.now() + 120000; let ready = false;
      while (Date.now() < deadline) { try { await fetch(base + "/api/auth/session"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } }
      if (!ready) throw new Error("Real Next application did not start");
      browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
      const device = await client.session.create({data:{userId:customerId,sessionToken:randomUUID(),expires:new Date(Date.now()+3600000)}});
      const token = await encode({ token: { sid:device.id,rotation:0,id: customerId, sub: customerId, email: "mig-test-1@example.com", role: "CUSTOMER" }, secret, salt: "authjs.session-token" });
      await context.addCookies([{ name: "authjs.session-token", value: token, url: base, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage(); await page.goto(base + "/book/" + vehicleId + "?reservationId=" + id);
      await page.getByRole("heading", { name: "Driver Information" }).waitFor();
      const fields = { "First Name": "Synthetic", "Last Name": "Driver", "Date of Birth": "1990-01-01", "Email": "mig-test-1@example.com", "Phone": "5551234567", "Address": "100 Test Street", "City": "Dallas", "State": "TX", "ZIP": "75001", "Country": "US", "License Number": "SYNTHETIC_ONLY", "License State/Country": "TX", "License Expiration": "2035-01-01" };
      for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value);
      const buffer = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
      for (let i = 0; i < 3; i++) { const uploaded = page.waitForResponse(r => r.url().endsWith("/api/documents/upload")); await page.locator("input[type=file]").nth(i).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer }); expect((await uploaded).status()).toBe(200); }
      const submitted = page.waitForResponse(r => r.url().endsWith("/api/reservations/hold"));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const response = await submitted; expect(response.status(), await response.text()).toBe(200); expect((await response.json()).id).toBe(id);
      await page.getByRole("heading", { name: "Review Your Booking" }).waitFor();
      expect(await page.getByText("2030-03-09 at 10:00", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Legacy child seat × 1", { exact: true }).count()).toBe(1);
      expect(await page.getByLabel("Promo Code").inputValue()).toBe("LEGACY10");
      await page.reload(); await page.getByRole("heading", { name: "Driver Information" }).waitFor();
      const after = await client.reservation.findUniqueOrThrow({ where: { id }, include: { extras: true, payments: true } });
      expect(after.bookingFingerprintVersion).toBe(2); expect(after.bookingFingerprint).not.toBe(old);
      expect({ ...after, bookingFingerprint: before.bookingFingerprint, bookingFingerprintVersion: before.bookingFingerprintVersion, updatedAt: before.updatedAt, expiresAt: before.expiresAt }).toEqual(before);
      const draft = await client.bookingDraft.findUniqueOrThrow({ where: { id: draftId } }); expect(draft.revision).toBe(7); expect(draft.fingerprintVersion).toBe(2); expect(draft.fingerprint).toBe(after.bookingFingerprint);
      expect(after.payments).toEqual(before.payments); expect(await client.reservation.count({ where: { customerId, status: "CHECKOUT_HOLD" } })).toBe(1);
      expect((await context.request.get(base + "/api/reservations/mig_test_res_confirmed/resume")).status()).toBe(200);
      expect(await client.reservation.findUniqueOrThrow({ where: { id: finalized.id } })).toEqual(finalized);
    } finally {
      await browser?.close();
      if (child && child.exitCode === null) { const stopped = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill(); await stopped; }
      await client.$disconnect(); sql(url("postgres"), ["-c", `DROP DATABASE "${name}"`]);
    }
  }, 210000);
});
