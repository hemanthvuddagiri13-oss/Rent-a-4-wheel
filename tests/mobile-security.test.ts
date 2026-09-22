import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { fixtureJurisdiction } from "./helpers/jurisdiction-fixture";
import { createMobileClient } from "../packages/mobile-client/src";
const fixture = vi.hoisted(() => ({ name: "mobile_" + crypto.randomUUID().replaceAll("-", "") + "_test", emails: [] as string[], storageRead: vi.fn(), storageWrite: vi.fn(), scan: vi.fn() }));
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!); url.pathname = "/" + fixture.name;
  return { prisma: new PrismaClient({ datasources: { db: { url: url.toString() } } }) };
});
// Only the external email delivery boundary is replaced; codes, auth, HTTP,
// sessions, domain transactions and locks all execute against real PostgreSQL.
vi.mock("@/lib/email", () => ({ sendEmail: async ({ html }: { html: string }) => { fixture.emails.push(html); return { sent: true }; } }));
vi.mock("@/lib/storage", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/storage")>(), readPrivateDocument: fixture.storageRead, storePrivateDocument: fixture.storageWrite }));
vi.mock("@/lib/clamav", () => ({ scanWithClamAv: fixture.scan }));
import { prisma } from "@/lib/prisma";
import { POST as authPost, GET as authGet } from "@/app/api/v1/mobile/auth/[action]/route";
import { POST as apiPost, GET as apiGet } from "@/app/api/v1/mobile/[...path]/route";
import { refreshMobileCredential, tokenHash } from "@/lib/mobile/auth";
import { mobileMutation } from "@/lib/mobile/mutation";
import { messageCommand, conversationAccess } from "@/lib/conversations";
import { createOrRefreshHold } from "@/lib/checkout-hold";

const source = new URL(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!);
const target = new URL(source); target.pathname = "/" + fixture.name;
const admin = new URL(source); admin.pathname = "/postgres";
function adminSql(sql: string) { execFileSync(process.env.PSQL_PATH ?? "psql", [admin.toString(), "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { timeout: 60000, stdio: ["ignore", "ignore", "inherit"] }); }
let server: Server, base: string;
beforeAll(async () => {
  if (!source.pathname.endsWith("_test")) throw new Error("Disposable database required");
  adminSql('CREATE DATABASE "' + fixture.name + '"');
  for (const migration of readdirSync("prisma/migrations").filter(n => /^\d/.test(n)).sort()) execFileSync(process.env.PSQL_PATH ?? "psql", [target.toString(), "-q", "-v", "ON_ERROR_STOP=1", "-f", path.resolve("prisma/migrations", migration, "migration.sql")], { timeout: 120000, stdio: ["ignore", "ignore", "inherit"] });
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new Request(base + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v ?? ""])), ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
      const parts = new URL(request.url).pathname.replace("/api/v1/mobile/", "").split("/");
      const result = parts[0] === "auth" ? await (req.method === "POST" ? authPost : authGet)(request, { params: Promise.resolve({ action: parts[1] }) }) : await (req.method === "POST" ? apiPost : apiGet)(request, { params: Promise.resolve({ path: parts }) });
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
}, 120000);
beforeEach(async () => {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'`;
  await prisma.$executeRawUnsafe("TRUNCATE " + tables.map(t => '"' + t.tablename.replaceAll('"', '""') + '"').join(",") + " CASCADE");
  fixture.emails.length = 0;
  fixture.storageRead.mockReset().mockResolvedValue({ buffer: Buffer.from("synthetic private bytes") });
  fixture.scan.mockReset().mockResolvedValue({ status: "CLEAN" });
  fixture.storageWrite.mockReset().mockImplementation(async (bytes: Buffer, mimeType: string, stableId: string) => {
    const key = "local:" + stableId + ".png";
    await prisma.privateObject.upsert({ where: { key }, update: {}, create: { key, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mimeType, state: "CLEAN", writeState: "STORED" } });
    return { storageKey: key };
  });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect(); adminSql('DROP DATABASE IF EXISTS "' + fixture.name + '" WITH (FORCE)');
});
const device = () => ({ deviceId: crypto.randomUUID(), platform: "IOS", appVersion: "1.0.0" });
type Credentials = { accessToken: string; refreshToken: string; sessionId: string };
const post = (route: string, body: unknown, token?: string, key?: string) => fetch(base + "/api/v1/mobile/" + route, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
const get = (route: string, token?: string) => fetch(base + "/api/v1/mobile/" + route, { headers: token ? { authorization: "Bearer " + token } : {} });
async function requestCode(email: string) {
  const response = await post("auth/request-code", { email }); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { accepted: true }, error: null });
  return fixture.emails.at(-1)!.match(/>(\d{6})<\//)![1];
}
async function login(email = crypto.randomUUID() + "@mobile.test") {
  const code = await requestCode(email), response = await post("auth/sign-in", { email, code, ...device() });
  expect(response.status).toBe(200); return { ...(await response.json()).data as Credentials, email };
}
it("HTTP first sign-in consumes hashed code and stores only hashed credentials", async () => {
  const c = await login(), user = await prisma.user.findUniqueOrThrow({ where: { email: c.email } });
  expect(user).toMatchObject({ role: "CUSTOMER", isActive: true });
  expect(await prisma.customer.count({ where: { userId: user.id } })).toBe(1);
  const code = await prisma.authCode.findFirstOrThrow(); expect(code.consumedAt).not.toBeNull(); expect(code.codeHash).toMatch(/^\$2/);
  const credential = await prisma.mobileCredential.findFirstOrThrow(); expect(credential.accessHash).toBe(tokenHash(c.accessToken)); expect(credential.refreshHash).toBe(tokenHash(c.refreshToken));
  expect(JSON.stringify(await prisma.mobileSession.findMany({ include: { credentials: true } }))).not.toContain(c.refreshToken);
  expect(credential.accessExpiresAt.getTime() - credential.createdAt.getTime()).toBeLessThanOrEqual(300000);
});
it("HTTP rejects code reuse and a web sign-in code", async () => {
  const email = "reuse@mobile.test", code = await requestCode(email), data = { email, code, ...device() };
  expect((await post("auth/sign-in", data)).status).toBe(200);
  expect((await post("auth/sign-in", data)).status).toBe(401);
  await prisma.authCode.updateMany({ data: { consumedAt: null, purpose: "SIGN_IN" } });
  expect((await post("auth/sign-in", data)).status).toBe(401); expect(await prisma.mobileSession.count()).toBe(1);
});
it("HTTP brute force consumes exactly five attempts and denies the correct code afterward", async () => {
  const email = "brute@mobile.test", code = await requestCode(email), data = { email, ...device() };
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 6; i++) expect((await post("auth/sign-in", { ...data, code: wrong })).status).toBe(401);
  expect((await post("auth/sign-in", { ...data, code })).status).toBe(401);
  expect((await prisma.authCode.findFirstOrThrow()).attempts).toBe(5); expect(await prisma.mobileSession.count()).toBe(0);
});
it("HTTP resend is enumeration-resistant and does not issue during cooldown", async () => {
  const email = "cooldown@mobile.test"; await requestCode(email);
  for (let i = 0; i < 3; i++) expect((await (await post("auth/request-code", { email })).json()).data).toEqual({ accepted: true });
  expect(fixture.emails).toHaveLength(1); expect(await prisma.authCode.count()).toBe(1);
});
it("HTTP refresh rotates, invalidates old access, and replay revokes the new credential", async () => {
  const c = await login(), response = await post("auth/refresh", { refreshToken: c.refreshToken }); expect(response.status).toBe(200);
  const next = (await response.json()).data as Credentials;
  expect((await get("me", c.accessToken)).status).toBe(401); expect((await get("me", next.accessToken)).status).toBe(200);
  expect((await post("auth/refresh", { refreshToken: c.refreshToken })).status).toBe(401);
  expect((await get("me", next.accessToken)).status).toBe(401); expect((await post("auth/refresh", { refreshToken: next.refreshToken })).status).toBe(401);
  expect(await prisma.mobileSession.findUnique({ where: { id: c.sessionId } })).toMatchObject({ revocationReason: "REFRESH_REUSE", reuseDetectedAt: expect.any(Date) });
  expect(await prisma.auditLog.count({ where: { action: "mobile.refresh_reuse" } })).toBe(1);
});
it("simultaneous refresh on distinct PostgreSQL connections fences replay", async () => {
  const c = await login(), url = new URL(target); url.searchParams.set("connection_limit", "1");
  const a = new PrismaClient({ datasources: { db: { url: url.toString() } } }), b = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  let arrived = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const fenced = (client: PrismaClient) => client.$extends({ query: { mobileCredential: { async findUnique({ args, query }) {
    const result = await query(args); if (args.select && ++arrived <= 2) { if (arrived === 2) release(); await barrier; } return result;
  } } } }) as unknown as PrismaClient;
  try {
    const [pa, pb] = await Promise.all([a.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`, b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`]); expect(pa[0].pid).not.toBe(pb[0].pid);
    const results = await Promise.allSettled([refreshMobileCredential(c.refreshToken, fenced(a)), refreshMobileCredential(c.refreshToken, fenced(b))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1); expect(arrived).toBe(2);
    expect(await prisma.mobileCredential.count()).toBe(2); expect((await prisma.mobileSession.findUniqueOrThrow({ where: { id: c.sessionId } })).revocationReason).toBe("REFRESH_REUSE");
    const winner = results.find(r => r.status === "fulfilled")! as PromiseFulfilledResult<Credentials>; expect((await get("me", winner.value.accessToken)).status).toBe(401);
  } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it.each(["logout", "logout-all"])("HTTP %s revokes access and refresh", async action => {
  const c = await login(); expect((await post("auth/" + action, {}, c.accessToken)).status).toBe(200);
  expect((await get("me", c.accessToken)).status).toBe(401); expect((await post("auth/refresh", { refreshToken: c.refreshToken })).status).toBe(401);
});
it("HTTP device revocation cannot revoke another user's device", async () => {
  const a = await login(), b = await login(); expect((await post("auth/revoke", { sessionId: b.sessionId }, a.accessToken)).status).toBe(404);
  expect((await get("me", b.accessToken)).status).toBe(200);
});
it("HTTP disabled accounts and role elevation invalidate current access and refresh", async () => {
  const a = await login(), b = await login();
  await prisma.user.update({ where: { email: a.email }, data: { isActive: false } }); await prisma.user.update({ where: { email: b.email }, data: { role: "SUPER_ADMIN" } });
  for (const c of [a, b]) { expect((await get("me", c.accessToken)).status).toBe(401); expect((await post("auth/refresh", { refreshToken: c.refreshToken })).status).toBe(401); }
});
it("HTTP errors, version, body limits and logs exclude credential and payload sentinels", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {}), c = await login();
  const response = await fetch(base + "/api/v1/mobile/me", { headers: { authorization: "Bearer " + c.accessToken, "x-api-version": "999", "x-request-id": "attacker-private-sentinel" } });
  expect(response.status).toBe(400); expect(response.headers.get("x-api-version")).toBe("1");
  const body = await response.json(); expect(body).toMatchObject({ data: null, error: { code: "INVALID_REQUEST" }, requestId: expect.any(String) }); expect(body.requestId).not.toBe("attacker-private-sentinel");
  expect((await post("auth/sign-in", { sensitive: "license-sentinel" + "x".repeat(24000) })).status).toBe(413);
  const logs = JSON.stringify(log.mock.calls); for (const secret of [c.accessToken, c.refreshToken, "license-sentinel", "attacker-private-sentinel"]) expect(logs).not.toContain(secret);
  expect((await get("documents?limit=51", c.accessToken)).status).toBe(400);
});
it("HTTP idempotent message retry writes exactly one message and receipt; changed body conflicts", async () => {
  const c = await login(), user = await prisma.user.findUniqueOrThrow({ where: { email: c.email } }), id = crypto.randomUUID();
  const vehicle = await prisma.vehicle.create({ data: { slug: id, vin: id, licensePlate: id, year: 2024, make: "Synthetic", model: "Fixture", category: "SEDAN", dailyRateCents: 10000, weeklyRateCents: 50000, monthlyRateCents: 100000 } });
  const conversation = await prisma.conversation.create({ data: { customerId: user.id, vehicleId: vehicle.id, retainUntil: new Date(Date.now() + 86400000) } });
  const key = crypto.randomUUID(), route = `conversations/${conversation.id}/messages`;
  for (let i = 0; i < 3; i++) expect((await post(route, { body: "Synthetic message" }, c.accessToken, key)).status).toBe(200);
  expect((await post(route, { body: "Changed" }, c.accessToken, key)).status).toBe(409);
  expect(await prisma.conversationMessage.count()).toBe(1); expect(await prisma.messageRevision.count()).toBe(1); expect(await prisma.mobileMutation.count()).toBe(1);
  const other = await login(); expect((await get(`conversations/${conversation.id}`, other.accessToken)).status).toBe(404);
});
it("domain failure rolls back mobile receipt and domain effect together", async () => {
  const c = await login(), req = new Request(base, { headers: { authorization: "Bearer " + c.accessToken, "idempotency-key": crypto.randomUUID() } });
  await expect(mobileMutation(req, "test.rollback", {}, async () => {}, async tx => { await tx.siteSetting.create({ data: { key: "mobile-crash", value: "synthetic" } }); throw new Error("Crash before receipt"); })).rejects.toThrow("Crash before receipt");
  expect(await prisma.siteSetting.count()).toBe(0); expect(await prisma.mobileMutation.count()).toBe(0);
});

async function tenantFixture() {
  await prisma.jurisdiction.upsert({ where: { code: "TX" }, create: { code: "TX" }, update: {} });
  const customer = await login(), owner = await login(), employee = await login(), other = await login();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: customer.email } });
  const hostUser = await prisma.user.update({ where: { email: owner.email }, data: { role: "HOST" } });
  const employeeUser = await prisma.user.update({ where: { email: employee.email }, data: { role: "HOST_EMPLOYEE" } });
  const host = await prisma.hostProfile.create({ data: { userId: hostUser.id, legalName: "Synthetic host", onboardingStatus: "APPROVED", jurisdictionCode: "TX" } });
  const membership = await prisma.hostEmployee.create({ data: { userId: employeeUser.id, hostId: host.id } });
  const id = crypto.randomUUID();
  const vehicle = await prisma.vehicle.create({ data: { hostId: host.id, jurisdictionCode: "TX", slug: id, vin: id, licensePlate: id, year: 2024, make: "Synthetic", model: "Fixture", category: "SEDAN", dailyRateCents: 10000, weeklyRateCents: 50000, monthlyRateCents: 100000 } });
  const reservation = await prisma.reservation.create({ data: { confirmationNumber: id, customerId: user.id, vehicleId: vehicle.id, jurisdictionCode: "TX", status: "CONFIRMED", pickupAt: new Date("2055-04-01T12:00:00Z"), returnAt: new Date("2055-04-02T12:00:00Z"), rateType: "DAILY", rateAmountCents: 10000, units: 1, subtotalCents: 10000, totalCents: 10000 } });
  return { customer, owner, employee, other, user, host, membership, vehicle, reservation };
}
it("HTTP current host tenancy, employee removal and role changes apply without token renewal", async () => {
  const f = await tenantFixture();
  for (const c of [f.owner, f.employee]) { expect((await get("host/fleet", c.accessToken)).status).toBe(200); expect((await get(`reservations/${f.reservation.id}`, c.accessToken)).status).toBe(200); }
  expect((await get("host/earnings", f.employee.accessToken)).status).toBe(403);
  expect((await get(`reservations/${f.reservation.id}`, f.other.accessToken)).status).toBe(404);
  await prisma.hostEmployee.update({ where: { id: f.membership.id }, data: { isActive: false } });
  expect((await get("host/fleet", f.employee.accessToken)).status).toBe(403);
  expect((await get(`reservations/${f.reservation.id}`, f.employee.accessToken)).status).toBe(403);
  await prisma.user.update({ where: { email: f.owner.email }, data: { role: "CUSTOMER" } });
  expect((await get("host/fleet", f.owner.accessToken)).status).toBe(403);
  expect((await get("me", f.owner.accessToken)).status).toBe(200);
});
it("HTTP a second host cannot access another tenant's reservation, documents or messages", async () => {
  const f = await tenantFixture(), user = await prisma.user.update({ where: { email: f.other.email }, data: { role: "HOST" } });
  await prisma.hostProfile.create({ data: { userId: user.id, legalName: "Other synthetic host", onboardingStatus: "APPROVED" } });
  for (const suffix of ["", "/documents", "/trip", "/agreements"]) expect((await get(`reservations/${f.reservation.id}${suffix}`, f.other.accessToken)).status).toBe(404);
  expect((await post("conversations", { reservationId: f.reservation.id }, f.other.accessToken, crypto.randomUUID())).status).toBe(404);
  expect(fixture.storageRead).not.toHaveBeenCalled();
});
it("HTTP quarantine, purpose-bound capability and employee revocation are checked before storage", async () => {
  const f = await tenantFixture();
  const doc = await prisma.driverDocument.create({ data: { userId: f.user.id, reservationId: f.reservation.id, type: "LICENSE_FRONT", storageKey: "local:synthetic.png", mimeType: "image/png", fileSizeBytes: 4, contentSha256: "f".repeat(64), malwareScanStatus: "QUARANTINED", retentionExpiresAt: new Date("2058-01-01") } });
  for (const c of [f.customer, f.employee, f.other]) expect((await post("files/access", { documentId: doc.id }, c.accessToken)).status).not.toBe(200);
  expect(fixture.storageRead).not.toHaveBeenCalled();
  await prisma.driverDocument.update({ where: { id: doc.id }, data: { malwareScanStatus: "CLEAN" } });
  const issued = await post("files/access", { documentId: doc.id }, f.employee.accessToken); expect(issued.status).toBe(200);
  const capability = (await issued.json()).data.capability;
  const read = (id = doc.id, token = f.employee.accessToken, cap = capability) => fetch(base + "/api/v1/mobile/files/" + id, { headers: { authorization: "Bearer " + token, "x-file-access": cap } });
  expect((await read()).status).toBe(200); expect(fixture.storageRead).toHaveBeenCalledTimes(1);
  expect((await read("other-document")).status).toBe(403); expect((await read(doc.id, f.other.accessToken)).status).toBe(403); expect((await read(doc.id, f.employee.accessToken, capability + "x")).status).toBe(403);
  await prisma.hostEmployee.update({ where: { id: f.membership.id }, data: { isActive: false } });
  expect((await read()).status).toBe(403); expect(fixture.storageRead).toHaveBeenCalledTimes(1);
  expect(await prisma.documentAccessLog.count({ where: { purpose: "mobile_identity_preview" } })).toBe(1);
});
it("HTTP upload persists immutable intent, scans/re-encodes and finalizes exactly once", async () => {
  const c = await login(), bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const input = { type: "LICENSE_FRONT", mimeType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  const initializeKey = crypto.randomUUID();
  const init = await post("uploads", input, c.accessToken, initializeKey); expect(init.status).toBe(200); const id = (await init.json()).data.id;
  expect((await (await post("uploads", input, c.accessToken, initializeKey)).json()).data.id).toBe(id);
  expect(await prisma.mobileUpload.count()).toBe(1); expect(fixture.storageWrite).not.toHaveBeenCalled();
  const key = crypto.randomUUID();
  const finalize = (body: Buffer = bytes) => fetch(base + `/api/v1/mobile/uploads/${id}/finalize`, { method: "POST", headers: { authorization: "Bearer " + c.accessToken, "idempotency-key": key, "content-type": "image/png" }, body: new Uint8Array(body) });
  expect((await finalize(Buffer.from("wrong content"))).status).toBe(409); expect(fixture.storageWrite).not.toHaveBeenCalled();
  expect((await finalize()).status).toBe(200); expect((await finalize()).status).toBe(200);
  expect(fixture.scan).toHaveBeenCalledTimes(1); expect(fixture.storageWrite).toHaveBeenCalledTimes(1);
  expect(await prisma.driverDocument.count()).toBe(1); expect(await prisma.privateObject.count()).toBe(1);
  expect(await prisma.mobileMutation.count()).toBe(3); // initialize, pre-IO intent, atomic finalize receipt
  expect((await prisma.mobileUpload.findUniqueOrThrow({ where: { id } })).finalizedAt).not.toBeNull();
});
it.each(["SCAN_UNAVAILABLE", "INFECTED"])("HTTP upload %s fails closed without storage or document writes", async status => {
  const c = await login(), bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  const init = await post("uploads", { type: "LICENSE_FRONT", mimeType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }, c.accessToken, crypto.randomUUID());
  expect(init.status).toBe(200); const id = (await init.json()).data.id; fixture.scan.mockResolvedValue({ status });
  const response = await fetch(base + `/api/v1/mobile/uploads/${id}/finalize`, { method: "POST", headers: { authorization: "Bearer " + c.accessToken, "idempotency-key": crypto.randomUUID(), "content-type": "image/png" }, body: new Uint8Array(bytes) });
  expect(response.status).toBe(503); expect(fixture.storageWrite).not.toHaveBeenCalled(); expect(await prisma.driverDocument.count()).toBe(0);
  expect((await prisma.mobileUpload.findUniqueOrThrow({ where: { id } })).finalizedAt).toBeNull();
});
it("HTTP holds reuse immutable receipts, reject overlap and block disabled jurisdiction", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  const data = { draftId: crypto.randomUUID(), revision: 1, vehicleId: f.vehicle.id, pickupAt: "2056-04-01T12:00:00Z", returnAt: "2056-04-02T12:00:00Z", extraIds: [] }, key = crypto.randomUUID();
  const held = await post("reservations/hold", data, f.customer.accessToken, key); expect(held.status).toBe(200); const id = (await held.json()).data.id;
  expect((await (await post("reservations/hold", data, f.customer.accessToken, key)).json()).data.id).toBe(id);
  expect((await post("reservations/hold", { ...data, returnAt: "2056-04-03T12:00:00Z" }, f.customer.accessToken, key)).status).toBe(409);
  expect((await post("reservations/hold", { ...data, draftId: crypto.randomUUID() }, f.other.accessToken, crypto.randomUUID())).status).toBe(409);
  await prisma.jurisdiction.update({ where: { code: "TX" }, data: { mode: "DISABLED" } });
  expect((await post("reservations/hold", { ...data, pickupAt: "2057-04-01T12:00:00Z", returnAt: "2057-04-02T12:00:00Z", draftId: crypto.randomUUID() }, f.other.accessToken, crypto.randomUUID())).status).toBe(409);
  expect((await (await get("vehicles")).json()).data.items).toEqual([]);
  expect(await prisma.reservation.count({ where: { status: "CHECKOUT_HOLD" } })).toBe(1);
});
it("HTTP expired hold cannot checkout or start; caller cannot elevate through admin paths", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  await prisma.reservation.update({ where: { id: f.reservation.id }, data: { status: "CHECKOUT_HOLD", expiresAt: new Date(0) } });
  const driver = { firstName: "Synthetic", lastName: "Guest", dob: "1990-01-01", email: "synthetic@mobile.test", phone: "5555555555", address: "Fixture", city: "Fixture", state: "TX", zip: "75001", country: "US", licenseNumber: "SYNTHETIC_ONLY", licenseState: "TX", licenseExpiration: "2059-01-01" };
  expect((await post(`reservations/${f.reservation.id}/checkout`, { driver, documentIds: { front: "a", back: "b", selfie: "c" }, agreementAccepted: true, agreementContentHash: "a".repeat(64) }, f.customer.accessToken, crypto.randomUUID())).status).toBe(409);
  expect((await post(`reservations/${f.reservation.id}/start`, {}, f.customer.accessToken, crypto.randomUUID())).status).toBe(409);
  expect((await post("admin/refund", {}, f.customer.accessToken, crypto.randomUUID())).status).toBe(404);
  expect(await prisma.trip.count()).toBe(0); expect(await prisma.payment.count()).toBe(0); expect(await prisma.agreementAcceptance.count()).toBe(0);
});
it("generated client reads the actual HTTP endpoint without web cookies", async () => {
  const c = await login(), client = createMobileClient({ baseUrl: base, allowLocalHttp: true, accessToken: async () => c.accessToken });
  expect(await client.call("me", {})).toMatchObject({ role: "CUSTOMER" });
  expect((await client.call("devices", {})).devices).toHaveLength(1);
  expect((await get("me")).status).toBe(401);
});

async function independentClients() {
  const url = new URL(target); url.searchParams.set("connection_limit", "1");
  const a = new PrismaClient({ datasources: { db: { url: url.toString() } } }), b = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const [pa, pb] = await Promise.all([a.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`, b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`]); expect(pa[0].pid).not.toBe(pb[0].pid);
  return [a, b] as const;
}
it("concurrent identical messages use distinct connections and a pre-lock barrier, committing once", async () => {
  const f = await tenantFixture(), conversation = await prisma.conversation.create({ data: { customerId: f.user.id, vehicleId: f.vehicle.id, reservationId: f.reservation.id, retainUntil: new Date("2058-01-01") } });
  const [a, b] = await independentClients(); let arrivals = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const wrapped = (db: PrismaClient) => { let first = true; return db.$extends({ query: { mobileCredential: { async findUnique({ args, query }) {
    const row = await query(args); if (first) { first = false; if (++arrivals === 2) release(); await barrier; } return row;
  } } } }) as unknown as PrismaClient; };
  const req = new Request(base, { headers: { authorization: "Bearer " + f.customer.accessToken, "idempotency-key": crypto.randomUUID() } });
  const invoke = (db: PrismaClient) => mobileMutation(req, "message.send", { id: conversation.id, body: "Concurrent synthetic message" }, async (tx, userId) => { await conversationAccess(tx, userId, conversation.id); }, (tx, userId) => messageCommand(userId, conversation.id, { action: "send", body: "Concurrent synthetic message" }, tx), db);
  try {
    const results = await Promise.all([invoke(wrapped(a)), invoke(wrapped(b))]); expect(results[0]).toEqual(results[1]); expect(arrivals).toBe(2);
    expect(await prisma.conversationMessage.count()).toBe(1); expect(await prisma.mobileMutation.count()).toBe(1); expect(await prisma.messageRevision.count()).toBe(1);
  } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it("overlapping holds contend on separate connections after a synchronization barrier", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma); const other = await prisma.user.findUniqueOrThrow({ where: { email: f.other.email } });
  const [a, b] = await independentClients(); let arrivals = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const wrapped = (db: PrismaClient) => db.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
    // Both live transactions reach the release-authority read before either
    // acquires the vehicle lock. This is actual DB contention, not a delay.
    if (operation === "$queryRaw" && JSON.stringify(args).includes("release-control")) { if (++arrivals === 2) release(); await barrier; }
    return query(args);
  } } }) as unknown as PrismaClient;
  const data = { vehicleId: f.vehicle.id, pickupAt: new Date("2057-04-01T12:00:00Z"), returnAt: new Date("2057-04-02T12:00:00Z"), extraIds: [], revision: 1 };
  try {
    const result = await Promise.allSettled([createOrRefreshHold({ ...data, customerId: f.user.id, draftId: crypto.randomUUID() }, wrapped(a)), createOrRefreshHold({ ...data, customerId: other.id, draftId: crypto.randomUUID() }, wrapped(b))]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(result.filter(r => r.status === "rejected")).toHaveLength(1); expect(arrivals).toBeGreaterThanOrEqual(2);
    expect(await prisma.reservation.count({ where: { status: "CHECKOUT_HOLD" } })).toBe(1);
  } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it("HTTP expired codes and access/refresh lifetimes fail closed", async () => {
  const email = "expired@mobile.test", code = await requestCode(email);
  await prisma.authCode.updateMany({ data: { expiresAt: new Date(0) } });
  expect((await post("auth/sign-in", { email, code, ...device() })).status).toBe(401);
  const c = await login();
  await prisma.mobileCredential.updateMany({ data: { accessExpiresAt: new Date(0) } });
  expect((await get("me", c.accessToken)).status).toBe(401);
  await prisma.mobileCredential.updateMany({ data: { refreshExpiresAt: new Date(0) } });
  expect((await post("auth/refresh", { refreshToken: c.refreshToken })).status).toBe(401);
});
it("HTTP account issuance limit remains five codes per hour beyond the resend cooldown", async () => {
  const email = "account-limit@mobile.test";
  for (let i = 0; i < 7; i++) {
    expect((await post("auth/request-code", { email })).status).toBe(200);
    await prisma.authCode.updateMany({ data: { createdAt: new Date(Date.now() - 61000) } });
  }
  expect(await prisma.authCode.count()).toBe(5); expect(fixture.emails).toHaveLength(5);
});
it("HTTP issuance throttles one IP across accounts without enumeration responses", async () => {
  for (let i = 0; i < 22; i++) {
    const r = await post("auth/request-code", { email: `ip-${i}@mobile.test` }); expect(r.status).toBe(200); expect((await r.json()).data).toEqual({ accepted: true });
  }
  expect(await prisma.authCode.count()).toBe(20); expect(fixture.emails).toHaveLength(20);
});
it("HTTP logout is per-device while logout-all revokes every native device", async () => {
  const first = await login();
  // Expire only the resend cooldown in controlled evidence, not a timer wait.
  await prisma.authCode.updateMany({ data: { createdAt: new Date(Date.now() - 61000) } });
  const second = await login(first.email);
  expect((await (await get("auth/devices", second.accessToken)).json()).data.devices).toHaveLength(2);
  expect((await post("auth/logout", {}, first.accessToken)).status).toBe(200);
  expect((await get("me", second.accessToken)).status).toBe(200);
  expect((await post("auth/logout-all", {}, second.accessToken)).status).toBe(200);
  for (const c of [first, second]) expect((await get("me", c.accessToken)).status).toBe(401);
});
it("HTTP checkout binds the displayed agreement and commits one immutable acceptance on retry", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  const content = "SYNTHETIC TEST AGREEMENT ONLY", contentHash = createHash("sha256").update(content).digest("hex");
  await prisma.legalDocument.create({ data: { type: "RENTAL_AGREEMENT", title: "Synthetic agreement", version: "synthetic-v1", content, needsAttorneyReview: false } });
  const data = { draftId: crypto.randomUUID(), revision: 1, vehicleId: f.vehicle.id, pickupAt: "2056-04-01T12:00:00Z", returnAt: "2056-04-02T12:00:00Z", extraIds: [] };
  const held = await post("reservations/hold", data, f.customer.accessToken, crypto.randomUUID()); expect(held.status).toBe(200); const id = (await held.json()).data.id;
  const docs = await Promise.all((["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"] as const).map(type => prisma.driverDocument.create({ data: { userId: f.user.id, type, storageKey: "local:synthetic-" + type + ".png", mimeType: "image/png", fileSizeBytes: 1, contentSha256: "f".repeat(64), malwareScanStatus: "CLEAN" } })));
  const driver = { firstName: "Synthetic", lastName: "Guest", dob: "1990-01-01", email: f.customer.email, phone: "5555555555", address: "Fixture", city: "Fixture", state: "TX", zip: "75001", country: "US", licenseNumber: "SYNTHETIC_ONLY", licenseState: "TX", licenseExpiration: "2059-01-01" };
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id } });
  const checkout = { driver, documentIds: { front: docs[0].id, back: docs[1].id, selfie: docs[2].id }, agreementAccepted: true, bookingFingerprint: r.bookingFingerprint, agreementContentHash: contentHash };
  const key = crypto.randomUUID(), route = `reservations/${id}/checkout`;
  expect((await post(route, { ...checkout, agreementContentHash: "0".repeat(64) }, f.customer.accessToken, key)).status).toBe(409);
  expect(await prisma.agreementAcceptance.count()).toBe(0);
  for (let i = 0; i < 2; i++) expect((await post(route, checkout, f.customer.accessToken, key)).status).toBe(200);
  expect(await prisma.agreementAcceptance.count()).toBe(1); expect(await prisma.financeSnapshot.count()).toBe(1);
  expect(await prisma.operationsJob.count({ where: { kind: "AGREEMENT" } })).toBe(1);
  const acceptance = await prisma.agreementAcceptance.findFirstOrThrow(); expect(acceptance.contentHash).toBe(contentHash);
  expect((await prisma.reservation.findUniqueOrThrow({ where: { id } })).status).toBe("AWAITING_PAYMENT");
  await prisma.reservation.update({ where: { id }, data: { expiresAt: new Date(0) } });
  expect((await post(route, checkout, f.customer.accessToken, key)).status).toBe(409);
  expect(await prisma.agreementAcceptance.findMany()).toEqual([acceptance]); expect(await prisma.payment.count()).toBe(0);
});
