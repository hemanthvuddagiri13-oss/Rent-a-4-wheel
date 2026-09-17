import { beforeAll, afterAll, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { encode } from "next-auth/jwt";
import sharp from "sharp";
import { createServer as createScannerServer, type Server as ScannerServer } from "node:net";
import { prisma, createTestCustomer, createTestHost, createTestVehicle, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";

let child: ChildProcess, browser: Browser;
let scanner: ScannerServer, scannerReply = "stream: scanner unavailable ERROR\0";
let priorHostLegal: Awaited<ReturnType<typeof prisma.legalDocument.findUnique>>;
const base = "http://127.0.0.1:3201", secret = "marketplace-browser-only-secret";
const users: string[] = [], hosts: string[] = [], vehicles: string[] = [];
const captures = "test-artifacts/marketplace";
async function login(user: { id: string; email: string; role: string }) {
  const context = await browser.newContext();
  const token = await encode({ token: { id: user.id, sub: user.id, email: user.email, role: user.role }, secret, salt: "authjs.session-token" });
  await context.addCookies([{ name: "authjs.session-token", value: token, url: base, httpOnly: true, sameSite: "Lax" }]);
  return context;
}
async function screenshot(page: Page, name: string, widths = [390, 1440]) {
  await page.locator("h1").waitFor();
  for (const loading of ["Loading your trip…", "Loading payment status…"]) await page.getByText(loading, { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(() => document.fonts.ready);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${captures}/${name}-${width}.png`, fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} overflows at ${width}px`).toBe(true);
    expect(await page.locator("h1").count()).toBe(1);
  }
}
beforeAll(async () => {
  await mkdir(captures, { recursive: true });
  priorHostLegal = await prisma.legalDocument.findUnique({ where: { type: "HOST_AGREEMENT" } });
  // Explicit provider-boundary fixture. The app's scanner client and all HTTP,
  // storage, authorization and database paths remain real. This is not a claim
  // that a deployed ClamAV engine or its signature database has been verified.
  scanner = createScannerServer(socket => {
    let bytes = Buffer.alloc(0), framed = false;
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!framed) { const end = bytes.indexOf(0); if (end < 0) return; bytes = bytes.subarray(end + 1); framed = true; }
      while (bytes.length >= 4) {
        const length = bytes.readUInt32BE(0); if (bytes.length < 4 + length) return;
        bytes = bytes.subarray(4 + length); if (!length) { socket.end(scannerReply); return; }
      }
    });
  });
  await new Promise<void>(resolve => scanner.listen(0, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["tests/helpers/app-server.mjs"], { stdio: "inherit", env: { ...process.env, CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String((scanner.address() as { port: number }).port), BROWSER_TEST_PORT: "3201", NODE_ENV: "development", AUTH_SECRET: secret, AUTH_TRUST_HOST: "true", NEXTAUTH_URL: base, AUTH_URL: base, STRIPE_SECRET_KEY: "", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "", STRIPE_WEBHOOK_SECRET: "", ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV: "true" } });
  let ready = false;
  for (let i = 0; i < 240; i++) { try { await fetch(`${base}/api/auth/session`); ready = true; break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  if (!ready) throw new Error("Real Next.js server unavailable");
  browser = await chromium.launch({ headless: true });
}, 150000);
afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill(); await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]); }
  if (scanner) await new Promise<void>(resolve => scanner.close(() => resolve()));
  await cleanupReservationsForVehicles(vehicles);
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.marketplaceFile.deleteMany({ where: { hostId: { in: hosts } } });
  await prisma.agreementAcceptance.deleteMany({ where: { vehicleId: { in: vehicles } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } });
  await prisma.vehicleOwner.deleteMany({ where: { hostId: { in: hosts } } });
  await prisma.hostProfile.deleteMany({ where: { id: { in: hosts } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  if (priorHostLegal) await prisma.legalDocument.update({ where: { type: "HOST_AGREEMENT" }, data: { content: priorHostLegal.content, version: priorHostLegal.version, needsAttorneyReview: priorHostLegal.needsAttorneyReview } });
  else await prisma.legalDocument.deleteMany({ where: { type: "HOST_AGREEMENT" } });
  await prisma.$disconnect();
});

it("uses real pages and HTTP for host onboarding, listing, owner and calendar operations", async () => {
  const user = await createTestCustomer(); users.push(user.id);
  const context = await login(user), page = await context.newPage();
  await page.goto(`${base}/host`); await page.getByRole("link", { name: "Start host application" }).click();
  for (const [label, value] of Object.entries({ "Legal name": "Browser Fleet LLC", "Business name": "Browser Fleet", "Business phone": "5551234567", "Business address": "1 Synthetic Street", City: "Dallas", State: "TX", "ZIP code": "75001" })) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Submit for review" }).click(); await page.waitForURL(`${base}/host`);
  const host = await prisma.hostProfile.findUniqueOrThrow({ where: { userId: user.id } }); hosts.push(host.id);
  expect(host.onboardingStatus).toBe("SUBMITTED");
  await screenshot(page, "host-overview", [375, 390, 430, 768, 1024, 1440]);
  await page.goto(`${base}/host/vehicles/new`);
  const fields = { "VIN (17 characters)": "1HGCM82633A123456", "License plate": "BROWSER", Make: "Honda", Model: "Accord", "Registration expiration": "2035-01-01", "Insurance expiration": "2035-01-01", "Describe your vehicle": "Synthetic browser listing with comfortable seating and practical storage." };
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value);
  await screenshot(page, "host-listing-form");
  await page.getByRole("button", { name: "Save listing for review" }).click();
  await page.waitForURL(/\/host\/vehicles\/(?!new)[^/]+$/);
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { hostId: host.id } }); vehicles.push(vehicle.id);
  expect(vehicle).toMatchObject({ status: "INACTIVE", listingApproval: "PENDING" });
  await page.getByLabel("Block start (your local time)").fill("2035-02-01T10:00");
  await page.getByLabel("Block end (your local time)").fill("2035-02-03T10:00");
  await page.getByRole("button", { name: "Block dates", exact: true }).click();
  await page.getByText("2035-02-01 → 2035-02-03", { exact: false }).waitFor();
  expect(await prisma.vehicleBlock.count({ where: { vehicleId: vehicle.id } })).toBe(1);
  await screenshot(page, "host-vehicle");
  const admin = await createTestCustomer({ role: "ADMIN" }); users.push(admin.id); const ac = await login(admin);
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: "silver" } }).png().toBuffer();
  async function upload(purpose: string) {
    await page.getByLabel("File purpose").selectOption(purpose);
    await page.getByLabel("Image (JPG, PNG or WebP, max 8 MB)").setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: image });
    const response = page.waitForResponse(r => r.url().endsWith("/api/host/files") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Upload file", exact: true }).click();
    const result = await response; expect(result.status(), await result.text()).toBe(200); return result.json();
  }
  const quarantined = await upload("OWNERSHIP"); expect(quarantined.scanStatus).toBe("QUARANTINED");
  expect((await ac.request.get(`${base}/api/marketplace/files/${quarantined.id}`)).status()).toBe(403);
  expect((await context.request.get(`${base}/api/marketplace/files/${quarantined.id}`)).status()).toBe(200);
  expect((await context.request.post(`${base}/api/host/vehicles/${vehicle.id}/agreement`, { data: { signerName: "Synthetic Host", version: priorHostLegal?.version || "v1-draft", accept: "yes" } })).status()).toBe(409);
  scannerReply = "stream: OK\0";
  for (const purpose of ["OWNERSHIP", "REGISTRATION", "INSURANCE", "LISTING_PHOTO"]) expect((await upload(purpose)).scanStatus).toBe("CLEAN");
  await prisma.legalDocument.upsert({ where: { type: "HOST_AGREEMENT" }, create: { type: "HOST_AGREEMENT", title: "Synthetic host agreement", content: "Synthetic browser terms, not production legal language", version: "browser-host", needsAttorneyReview: false }, update: { content: "Synthetic browser terms, not production legal language", version: "browser-host", needsAttorneyReview: false } });
  await page.reload(); await page.getByLabel("Full legal name", { exact: true }).fill("Synthetic Host");
  await page.getByRole("checkbox").check();
  const signed = page.waitForResponse(r => r.url().endsWith(`/api/host/vehicles/${vehicle.id}/agreement`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign listing agreement" }).click(); expect((await signed).status()).toBe(200);
  const acceptance = await prisma.agreementAcceptance.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
  expect(acceptance.signedPdfStorageKey).toBeTruthy();
  expect((await context.request.get(`${base}/api/host/vehicles/${vehicle.id}/agreement?acceptanceId=${acceptance.id}`)).headers()["content-type"]).toBe("application/pdf");
  expect((await ac.request.post(`${base}/api/admin/marketplace`, { data: { action: "host", id: host.id, status: "APPROVED", reason: "Synthetic browser evidence reviewed" } })).status()).toBe(200);
  const approval = await ac.request.post(`${base}/api/admin/marketplace`, { data: { action: "vehicle", id: vehicle.id, status: "APPROVED", reason: "Synthetic compliance files and signed snapshot reviewed" } });
  expect(approval.status(), await approval.text()).toBe(200);
  expect(await prisma.vehicle.findUnique({ where: { id: vehicle.id } })).toMatchObject({ listingApproval: "APPROVED", status: "ACTIVE" });
  const signedBefore = await (await context.request.get(`${base}/api/host/vehicles/${vehicle.id}/agreement?acceptanceId=${acceptance.id}`)).body();
  await page.reload(); await page.getByLabel("Describe your vehicle").fill("Revised synthetic vehicle description requiring a new signed listing snapshot.");
  const edited = page.waitForResponse(r => r.url().endsWith("/api/host/workspace") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save listing for review" }).click(); expect((await edited).status()).toBe(200);
  expect((await ac.request.post(`${base}/api/admin/marketplace`, { data: { action: "vehicle", id: vehicle.id, status: "APPROVED", reason: "Attempt to reuse an outdated listing signature" } })).status()).toBe(409);
  expect(await (await context.request.get(`${base}/api/host/vehicles/${vehicle.id}/agreement?acceptanceId=${acceptance.id}`)).body()).toEqual(signedBefore);
  await page.reload(); await page.getByLabel("Full legal name", { exact: true }).fill("Synthetic Host"); await page.getByRole("checkbox").check();
  const resigned = page.waitForResponse(r => r.url().endsWith(`/api/host/vehicles/${vehicle.id}/agreement`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign listing agreement" }).click(); expect((await resigned).status()).toBe(200);
  expect(await prisma.agreementAcceptance.count({ where: { vehicleId: vehicle.id } })).toBe(2);
  expect((await ac.request.post(`${base}/api/admin/marketplace`, { data: { action: "vehicle", id: vehicle.id, status: "APPROVED", reason: "Review current revision with matching signed evidence" } })).status()).toBe(200);
  await prisma.legalDocument.update({ where: { type: "HOST_AGREEMENT" }, data: { version: "browser-host-v2", content: "Changed synthetic template for stale-version rejection test" } });
  expect((await context.request.post(`${base}/api/host/vehicles/${vehicle.id}/agreement`, { data: { signerName: "Synthetic Host", version: "browser-host", accept: "yes" } })).status()).toBe(409);
  expect(await (await context.request.get(`${base}/api/host/vehicles/${vehicle.id}/agreement?acceptanceId=${acceptance.id}`)).body()).toEqual(signedBefore);
  const ap = await ac.newPage(); await ap.goto(`${base}/admin/marketplace/vehicles/${vehicle.id}`); await screenshot(ap, "admin-listing-review");
  await ap.goto(`${base}/admin/marketplace`); await screenshot(ap, "admin-operations"); await ac.close();
  await page.goto(`${base}/host/team`);
  await page.getByLabel("Owner name").fill("Synthetic Owner"); await page.getByLabel("Owner email").fill("owner@synthetic.test"); await page.getByLabel("Owner phone").fill("5551234567");
  await page.getByRole("button", { name: "Add vehicle owner" }).click(); await page.getByText("Synthetic Owner · owner@synthetic.test").waitFor();
  await screenshot(page, "host-team");
  const other = await createTestHost(); users.push(other.user.id); hosts.push(other.hostProfile.id);
  const unrelated = await login(other.user);
  expect((await unrelated.request.post(`${base}/api/host/workspace`, { data: { action: "availability", vehicleId: vehicle.id, isBookable: true } })).status()).toBe(404);
  expect((await context.request.post(`${base}/api/admin/marketplace`, { data: { action: "vehicle", id: vehicle.id, status: "APPROVED", reason: "self approval" } })).status()).toBe(403);
  expect((await unrelated.request.get(`${base}/api/marketplace/files/${quarantined.id}`)).status()).toBe(403);
  const staff = await createTestCustomer(); users.push(staff.id);
  expect((await context.request.post(`${base}/api/host/workspace`, { data: { action: "employee", email: staff.email, role: "STAFF" } })).status()).toBe(200);
  const sc = await login(staff);
  expect((await sc.request.get(`${base}/api/host/vehicles`)).status()).toBe(200);
  expect((await sc.request.post(`${base}/api/host/workspace`, { data: { action: "availability", vehicleId: vehicle.id, isBookable: false } })).status()).toBe(403);
  const employment = await prisma.hostEmployee.findFirstOrThrow({ where: { userId: staff.id } });
  expect((await context.request.post(`${base}/api/host/workspace`, { data: { action: "removeEmployee", id: employment.id } })).status()).toBe(200);
  expect((await sc.request.get(`${base}/api/host/vehicles`)).status()).toBe(403);
  await sc.close();
  await context.close(); await unrelated.close();
}, 180000);

it("completes real customer and host inspection, handoff, start and return journeys without bypassing the gate", async () => {
  const host = await createTestHost(), customer = await createTestCustomer(), outsider = await createTestCustomer();
  users.push(host.user.id, customer.id, outsider.id); hosts.push(host.hostProfile.id);
  const vehicle = await createTestVehicle({ hostId: host.hostProfile.id, securityDepositCents: 0 }); vehicles.push(vehicle.id);
  const r = await createTestReservation({ vehicleId: vehicle.id, customerId: customer.id, pickupAt: new Date(Date.now() + 3600000), returnAt: new Date(Date.now() + 86400000), status: "CONFIRMED", depositCents: 0 });
  // Synthetic upstream payment/document/legal evidence: this journey exercises
  // real operational routes, not Stripe or an external malware scanner.
  await prisma.payment.create({ data: { reservationId: r.id, type: "RENTAL", status: "SUCCEEDED", amountCents: r.totalCents } });
  await prisma.driverDocument.createMany({ data: (["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"] as const).map(type => ({ reservationId: r.id, userId: customer.id, type, storageKey: "local:synthetic-not-read", mimeType: "image/png", fileSizeBytes: 20, contentSha256: "synthetic", malwareScanStatus: "CLEAN" as const })) });
  await prisma.agreementAcceptance.create({ data: { reservationId: r.id, signedByUserId: customer.id, signerName: "Synthetic customer", type: "RENTAL_AGREEMENT", documentVersion: "browser-fixture", contentSnapshot: "Synthetic fixture, not legal content", contentHash: "fixture" } });
  const hc = await login(host.user), cc = await login(customer), oc = await login(outsider), hp = await hc.newPage(), cp = await cc.newPage();
  expect((await oc.request.get(`${base}/api/reservations/${r.id}/experience`)).status()).toBe(403);
  expect((await cc.request.post(`${base}/api/reservations/${r.id}/start-trip`)).status()).toBe(409);
  expect((await cc.request.post(`${base}/api/reservations/${r.id}/identity-handoff`, { data: { licenseMatchesUpload: true, physicalLicenseUnexpired: true, selfieMatchesCustomer: true } })).status()).toBe(403);
  await hp.goto(`${base}/host/reservations/${r.id}`); await cp.goto(`${base}/account/reservations/${r.id}`);
  await hp.getByLabel("Physical license matches uploaded license").check(); await hp.getByLabel("Physical license is unexpired").check(); await hp.getByLabel("Person matches the uploaded selfie").check();
  await hp.getByRole("button", { name: "Confirm identity handoff" }).click(); await hp.getByText("Identity handoff recorded.").waitFor();
  const buffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: "silver" } }).png().toBuffer();
  async function inspect(page: Page, mileage: string) {
    await page.getByLabel("Odometer (miles)").fill(mileage); await page.getByLabel("Fuel / battery (%)").fill("90");
    for (const label of ["Exterior photo", "Interior photo"]) await page.getByLabel(label, { exact: false }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer });
    await page.getByRole("button", { name: "Submit inspection report" }).click();
    await page.getByRole("button", { name: "I accept this report as accurate" }).click();
    await page.getByText("Saved. Your trip checklist is up to date.").waitFor();
  }
  await inspect(hp, "1000"); await inspect(cp, "1000");
  await hp.reload(); await hp.getByRole("button", { name: "Confirm keys handed over" }).click(); await hp.getByRole("button", { name: "Keys released", exact: true }).waitFor();
  await cp.reload(); await screenshot(cp, "customer-pickup"); await screenshot(hp, "host-pickup");
  await cp.getByRole("button", { name: "Start trip", exact: true }).click(); await cp.getByRole("heading", { name: "Your trip is underway" }).waitFor();
  expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("ACTIVE");
  await screenshot(cp, "active-trip");
  await cp.getByRole("button", { name: "Begin return inspection" }).click(); await cp.getByRole("heading", { name: "Your return inspection" }).waitFor();
  await hp.reload(); await inspect(cp, "1100"); await inspect(hp, "1100");
  await screenshot(hp, "host-return");
  await hp.getByRole("button", { name: "Complete return review" }).click(); await hp.getByText("Return complete.", { exact: false }).waitFor();
  await cp.reload(); await screenshot(cp, "completed-trip");
  expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("COMPLETED");
  const receipt = await cc.request.get(`${base}/api/reservations/${r.id}/receipt`); expect(receipt.status()).toBe(200); expect(receipt.headers()["content-type"]).toBe("application/pdf");
  expect((await oc.request.get(`${base}/api/reservations/${r.id}/receipt`)).status()).toBe(404);
  await hc.close(); await cc.close(); await oc.close();
}, 180000);

it("renders discovery and account pages at all requested widths with labeled form controls", async () => {
  const customer = await createTestCustomer(); users.push(customer.id);
  const context: BrowserContext = await login(customer), page = await context.newPage();
  for (const [path, name] of [["/", "home"], ["/vehicles", "discovery"], ["/account", "customer-account"]]) {
    await page.goto(base + path); await screenshot(page, name, [375, 390, 430, 768, 1024, 1440]);
    expect(await page.locator('input:not([type="hidden"]):not([type="checkbox"])').evaluateAll(elements => elements.filter(e => !(e as HTMLInputElement).labels?.length && !e.getAttribute("aria-label")).length)).toBe(0);
  }
  await context.close();
}, 120000);
