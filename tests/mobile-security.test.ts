import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createHash, createHmac } from "node:crypto";
import sharp from "sharp";
import { fixtureJurisdiction } from "./helpers/jurisdiction-fixture";
import { createMobileClient } from "../packages/mobile-client/src";
const fixture = vi.hoisted(() => ({ name: "mobile_" + crypto.randomUUID().replaceAll("-", "") + "_test", emails: [] as string[], storageRead: vi.fn(), storageWrite: vi.fn(), scan: vi.fn(), smsStart: vi.fn(), smsCheck: vi.fn() }));
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
vi.mock("@/lib/mobile/sms-provider", () => ({ smsProvider: () => ({ start: fixture.smsStart, check: fixture.smsCheck }) }));
import { prisma } from "@/lib/prisma";
import { POST as authPost, GET as authGet } from "@/app/api/v1/mobile/auth/[action]/route";
import { POST as apiPost, GET as apiGet } from "@/app/api/v1/mobile/[...path]/route";
import { refreshMobileCredential, tokenHash } from "@/lib/mobile/auth";
import { mobileMutation } from "@/lib/mobile/mutation";
import { messageCommand, conversationAccess } from "@/lib/conversations";
import { createOrRefreshHold } from "@/lib/checkout-hold";
import { verifyLoginChallenge } from "@/lib/mobile/login-identity";

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
  fixture.smsStart.mockReset().mockImplementation(async () => "fixture:" + crypto.randomUUID());
  fixture.smsCheck.mockReset().mockImplementation(async (_sid: string, code: string) => code === "123456");
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
  // Email fallback is only for an already verified, linked identity.
  await prisma.user.upsert({ where: { email }, update: {}, create: { email, emailVerified: new Date(), customer: { create: {} } } });
  const response = await post("auth/request-code", { email }); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { accepted: true }, error: null });
  return fixture.emails.at(-1)!.match(/>(\d{6})<\//)![1];
}
async function login(email = crypto.randomUUID() + "@mobile.test") {
  const code = await requestCode(email), response = await post("auth/sign-in", { email, code, ...device() });
  expect(response.status).toBe(200); return { ...(await response.json()).data as Credentials, email };
}
it("HTTP linked-email sign-in consumes hashed code and stores only hashed credentials", async () => {
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
it.each(["removed", "inactive", "expired"])("HTTP %s employee loses linked cases with the same native token but keeps standalone tickets", async change => {
  const f = await tenantFixture();
  const data = { kind: "TICKET", category: "OTHER", openedById: f.membership.userId, details: {}, dueAt: new Date("2056-01-01"), retainUntil: new Date("2058-01-01") };
  const linked = await prisma.serviceCase.create({ data: { ...data, title: "Synthetic linked request", reservationId: f.reservation.id, vehicleId: f.vehicle.id } });
  const standalone = await prisma.serviceCase.create({ data: { ...data, title: "Synthetic standalone request" } });
  const ids = async (token: string) => { const response = await get("cases", token); expect(response.status).toBe(200); return (await response.json()).data.items.map((item: { id: string }) => item.id); };
  expect(await ids(f.employee.accessToken)).toEqual(expect.arrayContaining([linked.id, standalone.id]));
  expect((await get(`cases/${linked.id}`, f.employee.accessToken)).status).toBe(200);
  // A missing cached case vehicle must not override the current reservation scope.
  await prisma.serviceCase.update({ where: { id: linked.id }, data: { vehicleId: null } });
  expect(await ids(f.employee.accessToken)).toContain(linked.id);
  expect((await get(`cases/${linked.id}`, f.employee.accessToken)).status).toBe(200);
  if (change === "removed") await prisma.hostEmployee.delete({ where: { id: f.membership.id } });
  else await prisma.hostEmployee.update({ where: { id: f.membership.id }, data: change === "inactive" ? { isActive: false } : { expiresAt: new Date(Date.now() - 1000) } });
  expect(await ids(f.employee.accessToken)).toEqual([standalone.id]);
  expect((await get(`cases/${linked.id}`, f.employee.accessToken)).status).toBe(403);
  expect((await get(`cases/${standalone.id}`, f.employee.accessToken)).status).toBe(200);
  for (const c of [f.owner, f.customer]) {
    expect(await ids(c.accessToken)).toEqual([linked.id]);
    expect((await get(`cases/${linked.id}`, c.accessToken)).status).toBe(200);
    expect((await get(`cases/${standalone.id}`, c.accessToken)).status).toBe(404);
  }
  expect(await ids(f.other.accessToken)).toEqual([]);
  expect((await get(`cases/${linked.id}`, f.other.accessToken)).status).toBe(404);
  expect((await prisma.mobileSession.findUniqueOrThrow({ where: { id: f.employee.sessionId } })).revokedAt).toBeNull();
});
it("HTTP pricing exposes host financial fields only to the reservation's current tenant owner", async () => {
  const f = await tenantFixture();
  const terms = { amounts: { guestServiceCents: 100, protectionCents: 200, guestProcessingCents: 300, commissionCents: 400, hostNetCents: 9000, riskReserveCents: 600 } };
  await prisma.financeQuote.create({ data: { reservationId: f.reservation.id, terms } });
  const route = `reservations/${f.reservation.id}/pricing`;
  const price = async (token: string) => { const response = await get(route, token); expect(response.status).toBe(200); return (await response.json()).data; };
  expect(await price(f.owner.accessToken)).toMatchObject({ hostCommissionCents: 400, hostEarningsCents: 9000, reserveCents: 600 });
  const guestOnly = async (token: string) => {
    const body = await price(token);
    expect(body).toMatchObject({ subtotalCents: 10000, totalCents: 10000, extrasCents: 0, discountCents: 0, taxCents: 0, depositCents: 0, platformFeeCents: 100, protectionCents: 200, processingCents: 300 });
    for (const field of ["hostCommissionCents", "hostEarningsCents", "reserveCents"]) expect(body).not.toHaveProperty(field);
  };
  await guestOnly(f.customer.accessToken); await guestOnly(f.employee.accessToken);
  await prisma.hostEmployee.update({ where: { id: f.membership.id }, data: { role: "MANAGER" } });
  await guestOnly(f.employee.accessToken);
  // Owning a different host account does not expose this booking's host finances.
  await prisma.user.update({ where: { id: f.user.id }, data: { role: "HOST" } });
  await prisma.hostProfile.create({ data: { userId: f.user.id, legalName: "Other synthetic owner", onboardingStatus: "APPROVED" } });
  await guestOnly(f.customer.accessToken);
  expect((await get(route, f.other.accessToken)).status).toBe(404);
  expect((await prisma.financeQuote.findUniqueOrThrow({ where: { reservationId: f.reservation.id } })).terms).toEqual(terms);
  expect(await prisma.reservation.findUnique({ where: { id: f.reservation.id } })).toEqual(f.reservation);
});
it.each(["jpeg", "png", "webp"] as const)("HTTP private %s response matches the generated OpenAPI media types", async format => {
  const f = await tenantFixture(), mimeType = `image/${format}`;
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
  fixture.storageRead.mockResolvedValue({ buffer: bytes });
  const doc = await prisma.driverDocument.create({ data: { userId: f.user.id, reservationId: f.reservation.id, type: "LICENSE_FRONT", storageKey: `local:synthetic.${format}`, mimeType, fileSizeBytes: bytes.length, contentSha256: createHash("sha256").update(bytes).digest("hex"), malwareScanStatus: "CLEAN", retentionExpiresAt: new Date("2058-01-01") } });
  const issued = await post("files/access", { documentId: doc.id }, f.customer.accessToken); expect(issued.status).toBe(200);
  const response = await fetch(base + "/api/v1/mobile/files/" + doc.id, { headers: { authorization: "Bearer " + f.customer.accessToken, "x-file-access": (await issued.json()).data.capability } });
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe(mimeType); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); expect(fixture.storageRead).toHaveBeenCalledTimes(1);
  const spec = JSON.parse(readFileSync("docs/api/mobile-v1.openapi.json", "utf8"));
  const content = spec.paths["/api/v1/mobile/files/{id}"].get.responses["200"].content;
  expect(Object.keys(content).sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
  expect(content[mimeType].schema).toEqual({ type: "string", format: "binary" });
});
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
it("HTTP reservation instructions expose the stored pickup location only to current participants", async () => {
  const f = await tenantFixture();
  await prisma.reservation.update({ where: { id: f.reservation.id }, data: { pickupLocation: "Synthetic host handoff point" } });
  for (const actor of [f.customer, f.owner]) {
    const response = await get(`reservations/${f.reservation.id}`, actor.accessToken);
    expect(response.status).toBe(200);
    expect((await response.json()).data.pickupLocation).toBe("Synthetic host handoff point");
  }
  const denied = await get(`reservations/${f.reservation.id}`, f.other.accessToken);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("Synthetic host handoff point");
});

it("HTTP customer availability is dated, gate-protected and never substitutes for a hold", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  const path = `vehicles/${f.vehicle.id}/availability`, dates = { pickupAt: '2056-04-01T12:00:00Z', returnAt: '2056-04-02T12:00:00Z' };
  const available = await post(path, dates); expect(available.status).toBe(200); expect((await available.json()).data).toMatchObject({ available: true, holdRequired: true });
  expect(await prisma.reservation.count()).toBe(1);
  const hold = await post('reservations/hold', { ...dates, vehicleId: f.vehicle.id, draftId: crypto.randomUUID(), revision: 1, extraIds: [] }, f.customer.accessToken, crypto.randomUUID()); expect(hold.status).toBe(200);
  expect((await (await post(path, dates)).json()).data.available).toBe(false);
  expect((await post('reservations/hold', { ...dates, vehicleId: f.vehicle.id, draftId: crypto.randomUUID(), revision: 1, extraIds: [] }, f.other.accessToken, crypto.randomUUID())).status).toBe(409);
  expect((await post(path, { ...dates, returnAt: dates.pickupAt })).status).toBe(400);
  expect((await post(path, { ...dates, pickupAt: 'not-a-date' })).status).toBe(400);
  await prisma.jurisdiction.update({ where: { code: 'TX' }, data: { mode: 'DISABLED' } });
  expect((await post(path, dates)).status).toBe(404);
});
it.each(["2056-04-01T12:00:01.000Z", "2056-04-01T12:00:00.123Z"])("HTTP availability and hold consistently reject sub-minute pickup %s without writes", async pickupAt => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  const dates = { pickupAt, returnAt: "2056-04-02T12:00:00.000Z" };
  const available = await post(`vehicles/${f.vehicle.id}/availability`, dates);
  expect(available.status).toBe(400);
  expect((await available.json()).error.code).toBe("INVALID_REQUEST");
  const held = await post("reservations/hold", { ...dates, vehicleId: f.vehicle.id, draftId: crypto.randomUUID(), revision: 1, extraIds: [] }, f.customer.accessToken, crypto.randomUUID());
  expect(held.status).toBe(400);
  expect((await held.json()).error.code).toBe("INVALID_REQUEST");
  expect(await prisma.reservation.count()).toBe(1);
  expect(await prisma.mobileMutation.count()).toBe(0);
  expect(await prisma.bookingDraft.count()).toBe(0);
});

it("HTTP listing photos expose only explicitly designated clean photos of the current host", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  const data = { vehicleId: f.vehicle.id, hostId: f.host.id, uploadedById: f.host.userId, storageKey: 'local:synthetic.png', mimeType: 'image/png', sha256: 'a'.repeat(64), scanStatus: 'CLEAN', purpose: 'LISTING_PHOTO' };
  const allowed = await prisma.marketplaceFile.create({ data });
  await prisma.marketplaceFile.create({ data: { ...data, purpose: 'INSURANCE' } });
  await prisma.marketplaceFile.create({ data: { ...data, scanStatus: 'QUARANTINED' } });
  await prisma.vehicleImage.create({ data: { vehicleId: f.vehicle.id, url: 'https://unapproved.invalid/private-sentinel.png' } });
  const response = await get(`vehicles/${f.vehicle.id}/photos`); expect(response.status).toBe(200);
  expect((await response.json()).data.items).toEqual([{ id: allowed.id, path: '/api/marketplace/files/' + allowed.id, alt: 'Host-authorized vehicle listing photo' }]);
  await prisma.vehicle.update({ where: { id: f.vehicle.id }, data: { listingApproval: 'PENDING' } });
  expect((await get(`vehicles/${f.vehicle.id}/photos`)).status).toBe(404);
  expect(fixture.storageRead).not.toHaveBeenCalled();
});
it("HTTP report photos repeat participation and private-object quarantine checks without public URLs", async () => {
  const f = await tenantFixture(), key = 'local:condition.png';
  await prisma.privateObject.create({ data: { key, sha256: 'a'.repeat(64), size: 4, mimeType: 'image/png', state: 'CLEAN', writeState: 'STORED' } });
  const report = await prisma.conditionReport.create({ data: { reservationId: f.reservation.id, phase: 'PRE_TRIP', submittedByRole: 'CUSTOMER', submittedById: f.user.id, mileage: 100, fuelLevel: 50, photos: { create: { category: 'EXTERIOR', storageKey: key } } }, include: { photos: true } });
  const path = `reservations/${f.reservation.id}/reports/${report.id}/photos/${report.photos[0].id}`;
  for (const c of [f.customer, f.owner, f.employee]) { const r = await get(path, c.accessToken); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toContain('no-store'); expect(r.headers.get('content-type')).toBe('image/png'); }
  expect((await get(path, f.other.accessToken)).status).toBe(404);
  await prisma.hostEmployee.delete({ where: { id: f.membership.id } }); expect((await get(path, f.employee.accessToken)).status).toBe(403);
  await prisma.privateObject.update({ where: { key }, data: { state: 'QUARANTINED' } }); expect((await get(path, f.customer.accessToken)).status).toBe(404);
  expect(fixture.storageRead).toHaveBeenCalledTimes(3); expect(await prisma.auditLog.count({ where: { action: 'mobile.report_photo.read' } })).toBe(3);
});
it("HTTP case history excludes internal notes and checks current membership on every page", async () => {
  const f = await tenantFixture();
  const c = await prisma.serviceCase.create({ data: { openedById: f.membership.userId, reservationId: f.reservation.id, vehicleId: f.vehicle.id, kind: 'TICKET', category: 'GENERAL', title: 'Synthetic support', details: {}, dueAt: new Date('2056-01-01'), retainUntil: new Date('2058-01-01') } });
  for (const internal of [false, true]) await prisma.serviceCaseEvent.create({ data: { caseId: c.id, actorId: f.user.id, action: 'reply', fromState: 'REPORTED', toState: 'REPORTED', body: internal ? 'PRIVATE_OPERATOR_SENTINEL' : 'Customer-visible reply', internal, version: internal ? 2 : 1 } });
  const path = `cases/${c.id}/events`;
  const response = await get(path, f.customer.accessToken); expect(response.status).toBe(200); const body = await response.json(); expect(body.data.items).toHaveLength(1); expect(JSON.stringify(body)).not.toContain('PRIVATE_OPERATOR_SENTINEL');
  expect((await get(path, f.employee.accessToken)).status).toBe(200);
  await prisma.hostEmployee.update({ where: { id: f.membership.id }, data: { expiresAt: new Date(0) } });
  expect((await get(path + '?limit=1', f.employee.accessToken)).status).toBe(403);
  expect((await get(path, f.other.accessToken)).status).toBe(404);
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
  const claim = JSON.parse(Buffer.from(capability.split(".")[0], "base64url").toString("utf8"));
  for (const override of [{ expires: 0 }, { purpose: "UNAUTHORIZED_PURPOSE" }, { session: "another-device" }]) {
    const payload = Buffer.from(JSON.stringify({ ...claim, ...override })).toString("base64url");
    const signed = payload + "." + createHmac("sha256", process.env.AUTH_SECRET!).update(payload).digest("base64url");
    expect((await read(doc.id, f.employee.accessToken, signed)).status).toBe(403);
  }
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
  const wrapped = (db: PrismaClient) => db.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
    // Both live transactions must reach the receipt lock before either can
    // acquire it. Authentication's last-used CAS has already committed.
    if (operation === "$queryRaw" && JSON.stringify(args).includes("mobile-mutation:")) { if (++arrivals === 2) release(); await barrier; }
    return query(args);
  } } }) as unknown as PrismaClient;
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
  await prisma.user.create({ data: { email, emailVerified: new Date() } });
  for (let i = 0; i < 7; i++) {
    expect((await post("auth/request-code", { email })).status).toBe(200);
    await prisma.authCode.updateMany({ data: { createdAt: new Date(Date.now() - 61000) } });
  }
  expect(await prisma.authCode.count()).toBe(5); expect(fixture.emails).toHaveLength(5);
  expect(await prisma.auditLog.count({ where: { action: "mobile.code_throttled" } })).toBe(2);
});
it("HTTP issuance throttles one IP across accounts without enumeration responses", async () => {
  for (let i = 0; i < 22; i++) {
    await prisma.user.create({ data: { email: `ip-${i}@mobile.test`, emailVerified: new Date() } });
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
it.each([false, true])("HTTP checkout (phone identity %s) binds verified contact and agreement with one immutable acceptance on retry", async phoneIdentity => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  if (phoneIdentity) await prisma.mobilePhoneIdentity.create({ data: { userId: f.user.id, phone: "+12025550101" } });
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
  if (phoneIdentity) {
    expect((await post(route, { ...checkout, driver: { ...driver, email: "unverified-other@example.test" } }, f.customer.accessToken, crypto.randomUUID())).status).toBe(409);
    expect(await prisma.agreementAcceptance.count()).toBe(0);
  }
  for (let i = 0; i < 2; i++) expect((await post(route, checkout, f.customer.accessToken, key)).status).toBe(200);
  expect(await prisma.agreementAcceptance.count()).toBe(1); expect(await prisma.financeSnapshot.count()).toBe(1);
  expect(await prisma.operationsJob.count({ where: { kind: "AGREEMENT" } })).toBe(1);
  const acceptance = await prisma.agreementAcceptance.findFirstOrThrow(); expect(acceptance.contentHash).toBe(contentHash);
  if (phoneIdentity) {
    await prisma.user.update({ where: { id: f.user.id }, data: { emailVerified: null } });
    expect((await post(route, checkout, f.customer.accessToken, key)).status).toBe(409);
    expect(await prisma.agreementAcceptance.findMany()).toEqual([acceptance]);
  }
  expect((await prisma.reservation.findUniqueOrThrow({ where: { id } })).status).toBe("AWAITING_PAYMENT");
  await prisma.reservation.update({ where: { id }, data: { expiresAt: new Date(0) } });
  expect((await post(route, checkout, f.customer.accessToken, key)).status).toBe(409);
  expect(await prisma.agreementAcceptance.findMany()).toEqual([acceptance]); expect(await prisma.payment.count()).toBe(0);
});
it("public discovery excludes vehicles under an active safety hold", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma);
  expect((await get(`vehicles/${f.vehicle.id}`)).status).toBe(200);
  await prisma.serviceCase.create({ data: { kind: "INCIDENT", category: "VEHICLE", title: "Synthetic safety hold", details: {}, openedById: f.user.id, vehicleId: f.vehicle.id, safetyBlock: true, dueAt: new Date("2058-01-01"), retainUntil: new Date("2059-01-01") } });
  expect((await get(`vehicles/${f.vehicle.id}`)).status).toBe(404);
  expect((await (await get("vehicles")).json()).data.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: f.vehicle.id })]));
});
it("refresh and an in-flight domain mutation cannot invert user/device locks", async () => {
  const c = await login(), [a, b] = await independentClients();
  let authorized!: () => void, userLocked!: () => void;
  const atAuthorization = new Promise<void>(resolve => { authorized = resolve; });
  const atUserLock = new Promise<void>(resolve => { userLocked = resolve; });
  let observedUserLock = false;
  const refreshDb = b.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
    const result = await query(args);
    if (operation === "$queryRaw" && JSON.stringify(args).includes('User') && JSON.stringify(args).includes('FOR UPDATE')) { observedUserLock = true; userLocked(); }
    return result;
  } } }) as unknown as PrismaClient;
  const req = new Request(base, { headers: { authorization: "Bearer " + c.accessToken, "idempotency-key": crypto.randomUUID() } });
  try {
    const mutation = mobileMutation(req, "test.lock-order", {}, async () => { authorized(); await atUserLock; }, async (tx, userId) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR UPDATE`;
      return { success: true };
    }, a);
    const rotation = (async () => { await atAuthorization; return refreshMobileCredential(c.refreshToken, refreshDb); })();
    const [result, rotated] = await Promise.all([mutation, rotation]);
    expect(observedUserLock).toBe(true); expect(result).toEqual({ success: true });
    expect(await prisma.mobileMutation.count()).toBe(1); expect(await prisma.mobileCredential.count()).toBe(2);
    expect((await get("me", c.accessToken)).status).toBe(401); expect((await get("me", rotated.accessToken)).status).toBe(200);
  } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
});

async function phoneChallenge(phone = "+12025550101", d = device()) {
  const response = await post("auth/request-phone-code", { phone, deviceId: d.deviceId });
  expect(response.status).toBe(200);
  const result = (await response.json()).data;
  expect(result).toMatchObject({ accepted: true, retryAfterSeconds: 60 });
  return { ...d, challengeId: result.challengeId as string, code: "123456" };
}
async function phoneLogin(phone = "+12025550101") {
  const input = await phoneChallenge(phone), response = await post("auth/phone-sign-in", input);
  expect(response.status).toBe(200); return { ...(await response.json()).data as Credentials, phone, input };
}
async function identityChallenge(token: string, purpose: string, target: string, proofId?: string) {
  const response = await post("auth/request-identity-code", { purpose, target, ...(proofId ? { proofId } : {}) }, token);
  expect(response.status).toBe(200); return (await response.json()).data.challengeId as string;
}
const verifyIdentity = (token: string, challengeId: string, code = "123456") => post("auth/verify-identity-code", { challengeId, code }, token);
async function agePhoneCooldown() { await prisma.mobileLoginChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 61000) } }); }
async function linkEmail(token: string, email: string) {
  const id = await identityChallenge(token, "LINK_EMAIL", email), code = fixture.emails.at(-1)!.match(/>(\d{6})<\//)![1];
  const response = await verifyIdentity(token, id, code); expect(response.status).toBe(200); return id;
}
it("HTTP phone registration normalizes identity, never merges legacy contact data, and leaves email unverified", async () => {
  const legacy = await prisma.user.create({ data: { email: "existing@example.test", emailVerified: new Date(), phone: "+12025550101" } });
  const first = await phoneLogin("(202) 555-0101"), identity = await prisma.mobilePhoneIdentity.findUniqueOrThrow({ where: { phone: "+12025550101" } });
  expect(identity.userId).not.toBe(legacy.id);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: identity.userId } });
  expect(user.emailVerified).toBeNull(); expect(user.email).toMatch(/@phone.identity.invalid$/);
  expect(await prisma.customer.count({ where: { userId: user.id } })).toBe(1);
  expect((await (await get("auth/methods", first.accessToken)).json()).data).toMatchObject({ phoneLinked: true, emailLinked: false, email: null });
  await agePhoneCooldown(); const second = await phoneLogin("+1 202 555 0101");
  expect(await prisma.mobilePhoneIdentity.count()).toBe(1); expect(await prisma.user.count()).toBe(2);
  expect((await (await get("me", second.accessToken)).json()).data.id).toBe(user.id);
  expect(fixture.smsStart).toHaveBeenCalledTimes(2); expect(fixture.smsCheck).toHaveBeenCalledTimes(2);
  const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { action: { startsWith: "mobile.identity." } } }));
  expect(audit).not.toContain("+12025550101"); expect(audit).not.toContain("123456");
});
it("HTTP phone code is bound to device, expires, and consumes only once", async () => {
  const data = await phoneChallenge();
  expect((await post("auth/phone-sign-in", { ...data, deviceId: crypto.randomUUID() })).status).toBe(401);
  expect(fixture.smsCheck).not.toHaveBeenCalled();
  expect((await post("auth/phone-sign-in", data)).status).toBe(200);
  expect((await post("auth/phone-sign-in", data)).status).toBe(401);
  expect(fixture.smsCheck).toHaveBeenCalledTimes(1); expect(await prisma.mobileVerificationReceipt.count()).toBe(1);
  const expired = await phoneChallenge("+12025550102");
  await prisma.mobileLoginChallenge.update({ where: { id: expired.challengeId }, data: { expiresAt: new Date(0) } });
  expect((await post("auth/phone-sign-in", expired)).status).toBe(401);
  expect(await prisma.mobileSession.count()).toBe(1);
});
it("HTTP phone guessing reserves exactly five attempts and cannot approve a sixth", async () => {
  const data = await phoneChallenge();
  for (let i = 0; i < 6; i++) expect((await post("auth/phone-sign-in", { ...data, code: "999999" })).status).toBe(401);
  expect((await post("auth/phone-sign-in", data)).status).toBe(401);
  expect(fixture.smsCheck).toHaveBeenCalledTimes(5); expect(await prisma.mobileSession.count()).toBe(0);
});
it("HTTP phone cooldown and per-number issuance limit prevent duplicate SMS", async () => {
  await phoneChallenge();
  for (let i = 0; i < 3; i++) await phoneChallenge();
  expect(fixture.smsStart).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 6; i++) { await agePhoneCooldown(); await phoneChallenge(); }
  expect(fixture.smsStart).toHaveBeenCalledTimes(5); expect(await prisma.mobileLoginChallenge.count()).toBe(5);
});
it("HTTP phone issuance enforces device and IP limits across numbers", async () => {
  const d = device();
  for (let i = 0; i < 12; i++) await phoneChallenge("+120255501" + String(i).padStart(2, "0"), d);
  expect(fixture.smsStart).toHaveBeenCalledTimes(10);
  for (let i = 12; i < 24; i++) await phoneChallenge("+120255501" + String(i).padStart(2, "0"));
  expect(fixture.smsStart).toHaveBeenCalledTimes(20);
});
it("HTTP provider send/check failures leave durable failed intent and grant no account or session", async () => {
  fixture.smsStart.mockRejectedValueOnce(new Error("provider credential sentinel"));
  const failed = await post("auth/request-phone-code", { phone: "+12025550101", deviceId: crypto.randomUUID() });
  expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("sentinel");
  expect(await prisma.mobileLoginChallenge.findFirst()).toMatchObject({ state: "FAILED" });
  const data = await phoneChallenge("+12025550102"); fixture.smsCheck.mockRejectedValueOnce(new Error("lost provider approval"));
  expect((await post("auth/phone-sign-in", data)).status).toBe(503);
  expect((await post("auth/phone-sign-in", data)).status).toBe(401);
  expect(fixture.smsCheck).toHaveBeenCalledTimes(1); expect(await prisma.user.count()).toBe(0);
  expect(await prisma.mobileSession.count()).toBe(0);
});
it("parallel PostgreSQL connections consume a challenge once while provider approval is in flight", async () => {
  const data = await phoneChallenge(), [a, b] = await independentClients();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), barrier = new Promise<void>(r => { release = r; });
  fixture.smsCheck.mockImplementation(async () => { enter(); await barrier; return true; });
  try {
    const first = verifyLoginChallenge(data, undefined, a); await entered;
    await expect(verifyLoginChallenge(data, undefined, b)).rejects.toMatchObject({ status: 401 });
    release(); await first;
    expect(fixture.smsCheck).toHaveBeenCalledTimes(1); expect(await prisma.mobileSession.count()).toBe(1);
    expect(await prisma.mobilePhoneIdentity.count()).toBe(1); expect(await prisma.mobileVerificationReceipt.count()).toBe(1);
  } finally { release(); await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it("two approved phone challenges on separate connections create one account without automatic merging", async () => {
  const first = await phoneChallenge(); await agePhoneCooldown(); const second = await phoneChallenge();
  const [a, b] = await independentClients(); let arrived = 0, release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  fixture.smsCheck.mockImplementation(async () => { if (++arrived === 2) release(); await barrier; return true; });
  try {
    await Promise.all([verifyLoginChallenge(first, undefined, a), verifyLoginChallenge(second, undefined, b)]);
    expect(arrived).toBe(2); expect(await prisma.user.count()).toBe(1); expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.mobilePhoneIdentity.count()).toBe(1); expect(await prisma.mobileSession.count()).toBe(2);
  } finally { release(); await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it("one provider approval SID cannot authorize two local challenges", async () => {
  fixture.smsStart.mockResolvedValue("fixture:same-provider-verification");
  const first = await phoneChallenge(); await agePhoneCooldown(); const second = await phoneChallenge();
  expect((await post("auth/phone-sign-in", first)).status).toBe(200);
  expect((await post("auth/phone-sign-in", second)).status).toBe(409);
  expect(await prisma.mobileSession.count()).toBe(1); expect(await prisma.mobileVerificationReceipt.count()).toBe(1);
});
it("email fallback stays generic for unknown/unverified addresses and cannot create a customer", async () => {
  await prisma.user.create({ data: { email: "unverified@example.test" } });
  for (const email of ["unknown@example.test", "unverified@example.test"]) {
    const response = await post("auth/request-code", { email }); expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ accepted: true });
    expect((await post("auth/sign-in", { email, code: "123456", ...device() })).status).toBe(401);
  }
  expect(fixture.emails).toHaveLength(0); expect(await prisma.authCode.count()).toBe(0);
  expect(await prisma.user.count()).toBe(1); expect(await prisma.mobileSession.count()).toBe(0);
});
it("verified email linking enables fallback for the same phone account without creating a duplicate", async () => {
  const c = await phoneLogin(); await linkEmail(c.accessToken, "linked@example.test");
  expect((await (await get("auth/methods", c.accessToken)).json()).data).toMatchObject({ emailLinked: true, email: "linked@example.test" });
  const code = await requestCode("linked@example.test"), response = await post("auth/sign-in", { email: "linked@example.test", code, ...device() });
  expect(response.status).toBe(200); expect(await prisma.user.count()).toBe(1);
  const identity = await prisma.mobilePhoneIdentity.findFirstOrThrow();
  expect((await (await get("me", (await response.json()).data.accessToken)).json()).data.id).toBe(identity.userId);
});
it("linking rejects an email or verified phone already belonging to another account", async () => {
  const owner = await login("owner@example.test"), c = await phoneLogin();
  const denied = await identityChallenge(c.accessToken, "LINK_EMAIL", owner.email);
  expect((await verifyIdentity(c.accessToken, denied)).status).toBe(401);
  const other = await login("other@example.test"); await agePhoneCooldown();
  const phone = await identityChallenge(other.accessToken, "LINK_PHONE", c.phone);
  expect((await verifyIdentity(other.accessToken, phone)).status).toBe(401);
  expect(await prisma.user.count()).toBe(3); expect(await prisma.mobilePhoneIdentity.count()).toBe(1);
  expect(fixture.smsStart).toHaveBeenCalledTimes(1);
});
it("phone change requires current-number proof in the same fresh session and revokes every native session", async () => {
  const c = await phoneLogin(); await agePhoneCooldown();
  const blocked = await identityChallenge(c.accessToken, "CHANGE_PHONE", "+12025550102");
  expect((await verifyIdentity(c.accessToken, blocked)).status).toBe(401);
  const current = await identityChallenge(c.accessToken, "CURRENT_PHONE", c.phone);
  const proved = await verifyIdentity(c.accessToken, current); expect(proved.status).toBe(200);
  const proofId = (await proved.json()).data.proofId;
  await agePhoneCooldown();
  const replacement = await identityChallenge(c.accessToken, "CHANGE_PHONE", "+12025550102", proofId);
  const response = await verifyIdentity(c.accessToken, replacement); expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ outcome: "LINKED", requiresSignIn: true });
  expect((await prisma.mobilePhoneIdentity.findFirstOrThrow()).phone).toBe("+12025550102");
  expect((await get("me", c.accessToken)).status).toBe(401);
  expect((await post("auth/refresh", { refreshToken: c.refreshToken })).status).toBe(401);
  expect(await prisma.mobilePhoneIdentity.count()).toBe(1);
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function preparedPhoneChange() {
  const c = await phoneLogin(); await agePhoneCooldown();
  const current = await identityChallenge(c.accessToken, "CURRENT_PHONE", c.phone);
  const proved = await verifyIdentity(c.accessToken, current); expect(proved.status).toBe(200);
  const replacement = await identityChallenge(c.accessToken, "CHANGE_PHONE", "+12025550102", (await proved.json()).data.proofId);
  await agePhoneCooldown();
  return { c, replacement, signIn: await phoneChallenge(c.phone) };
}
it.each(["change", "sign-in"] as const)("phone binding race: %s commits first under real PostgreSQL lock contention", async first => {
  const { c, replacement, signIn } = await preparedPhoneChange(), [a, b] = await independentClients();
  const userId = (await prisma.mobilePhoneIdentity.findFirstOrThrow()).userId;
  const [winnerPid] = await a.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const [waiterPid] = await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const locked = signal(), release = signal(); let approved = false, stopped = false;
  const winnerDb = a.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
    const result = await query(args);
    // Stop only finalization, after provider approval and the real User lock.
    // The challenge-claim transaction also locks User for identity changes.
    if (!stopped && approved && operation === "$queryRaw" && JSON.stringify(args).includes("User") && JSON.stringify(args).includes("FOR UPDATE")) {
      stopped = true; locked.resolve(); await release.promise;
    }
    return result;
  } } }) as unknown as PrismaClient;
  const provider = { start: fixture.smsStart, check: async () => { approved = true; return true; } };
  const headers = new Headers({ authorization: "Bearer " + c.accessToken });
  const change = (db: PrismaClient, p?: typeof provider) => verifyLoginChallenge({ challengeId: replacement, code: "123456" }, headers, db, p);
  const login = (db: PrismaClient, p?: typeof provider) => verifyLoginChallenge(signIn, undefined, db, p);
  const winner = (first === "change" ? change : login)(winnerDb, provider);
  let waiter: ReturnType<typeof verifyLoginChallenge> | undefined;
  try {
    await locked.promise;
    waiter = (first === "change" ? login : change)(b);
    const resultsPromise = Promise.allSettled([winner, waiter]);
    // Database-observed blocking is the barrier. No sleeps/timing inference:
    // release only once the independent backend is actually waiting on winner.
    let blocked = false; const deadline = Date.now() + 4000;
    while (!blocked && Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${winnerPid.pid}::int = ANY(pg_blocking_pids(${waiterPid.pid}::int)) AS blocked`;
      blocked = row.blocked;
    }
    expect(blocked).toBe(true); release.resolve();
    const results = await resultsPromise;
    expect(results[0].status).toBe("fulfilled");
    if (first === "change") expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 401 } });
    else {
      expect(results[1].status).toBe("fulfilled");
      const tokens = (results[0] as PromiseFulfilledResult<Credentials>).value;
      expect((await get("me", tokens.accessToken)).status).toBe(401);
      expect((await post("auth/refresh", { refreshToken: tokens.refreshToken })).status).toBe(401);
    }
    expect(await prisma.mobilePhoneIdentity.findUnique({ where: { phone: c.phone } })).toBeNull();
    expect(await prisma.mobilePhoneIdentity.findUnique({ where: { phone: "+12025550102" } })).toMatchObject({ userId, version: 2 });
    expect(await prisma.mobilePhoneIdentity.count()).toBe(1); expect(await prisma.user.count()).toBe(1);
    expect(await prisma.mobileSession.count()).toBe(first === "change" ? 1 : 2);
    expect(await prisma.mobileCredential.count()).toBe(first === "change" ? 1 : 2);
    expect(await prisma.mobileSession.count({ where: { revokedAt: null } })).toBe(0);
    expect((await get("me", c.accessToken)).status).toBe(401);
    expect((await post("auth/refresh", { refreshToken: c.refreshToken })).status).toBe(401);
    expect((await post("auth/phone-sign-in", signIn)).status).toBe(401);
    expect(await prisma.mobileSession.count()).toBe(first === "change" ? 1 : 2);
    // Only a fresh new-number proof can restore access to the same account.
    await agePhoneCooldown(); const fresh = await phoneLogin("+12025550102");
    expect((await (await get("me", fresh.accessToken)).json()).data.id).toBe(userId);
    expect(await prisma.mobileSession.count({ where: { revokedAt: null } })).toBe(1);
  } finally { release.resolve(); await Promise.allSettled([winner, ...(waiter ? [waiter] : [])]); await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it("an old sign-in challenge cannot become registration after its phone binding is removed", async () => {
  const { c, replacement, signIn } = await preparedPhoneChange();
  expect((await verifyIdentity(c.accessToken, replacement)).status).toBe(200);
  expect((await post("auth/phone-sign-in", signIn)).status).toBe(401);
  expect(await prisma.user.count()).toBe(1); expect(await prisma.mobileSession.count()).toBe(1);
  expect(await prisma.mobileLoginChallenge.findUnique({ where: { id: signIn.challengeId } })).toMatchObject({ state: "FAILED" });
});
it("sign-in rechecks the frozen identity version even when the phone and user still match", async () => {
  const c = await phoneLogin(); await agePhoneCooldown(); const input = await phoneChallenge();
  // Simulate a remove/re-link ABA: exact number and owner match, version differs.
  await prisma.mobilePhoneIdentity.update({ where: { phone: c.phone }, data: { version: { increment: 2 } } });
  expect((await post("auth/phone-sign-in", input)).status).toBe(401);
  expect(await prisma.mobileSession.count()).toBe(1);
  expect(await prisma.mobileVerificationReceipt.count()).toBe(1);
});
it("linking invalidates an approved registration challenge without transferring ownership", async () => {
  const owner = await login(), input = await phoneChallenge(); await agePhoneCooldown();
  const link = await identityChallenge(owner.accessToken, "LINK_PHONE", "+12025550101"), [a, b] = await independentClients();
  const checked = signal(), release = signal();
  const provider = { start: fixture.smsStart, check: async () => { checked.resolve(); await release.promise; return true; } };
  const pending = verifyLoginChallenge(input, undefined, a, provider);
  try {
    await checked.promise;
    await verifyLoginChallenge({ challengeId: link, code: "123456" }, new Headers({ authorization: "Bearer " + owner.accessToken }), b);
    const result = Promise.allSettled([pending]); release.resolve();
    expect((await result)[0]).toMatchObject({ status: "rejected", reason: { status: 401 } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: owner.email } });
    expect(await prisma.mobilePhoneIdentity.findUnique({ where: { phone: "+12025550101" } })).toMatchObject({ userId: user.id });
    expect(await prisma.user.count()).toBe(1); expect(await prisma.mobileSession.count()).toBe(1);
    expect(await prisma.mobileVerificationReceipt.count()).toBe(1);
    expect((await get("me", owner.accessToken)).status).toBe(200);
    expect((await post("auth/phone-sign-in", input)).status).toBe(401);
  } finally { release.resolve(); await Promise.allSettled([pending]); await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it("revocation during provider verification fences linking before identity authority changes", async () => {
  const c = await login(), id = await identityChallenge(c.accessToken, "LINK_PHONE", "+12025550101");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), barrier = new Promise<void>(r => { release = r; });
  fixture.smsCheck.mockImplementation(async () => { enter(); await barrier; return true; });
  const pending = verifyIdentity(c.accessToken, id); await entered;
  expect((await post("auth/logout", {}, c.accessToken)).status).toBe(200); release();
  expect((await pending).status).toBe(401); expect(await prisma.mobilePhoneIdentity.count()).toBe(0);
  expect(await prisma.mobileLoginChallenge.findUnique({ where: { id } })).toMatchObject({ state: "FAILED" });
});
it("identity linking rejects stale sessions and phone proof from another session", async () => {
  const c = await phoneLogin(); await agePhoneCooldown();
  const id = await identityChallenge(c.accessToken, "CURRENT_PHONE", c.phone), proved = await verifyIdentity(c.accessToken, id);
  const proofId = (await proved.json()).data.proofId;
  await agePhoneCooldown(); const other = await phoneLogin(); await agePhoneCooldown();
  const replacement = await identityChallenge(other.accessToken, "CHANGE_PHONE", "+12025550102", proofId);
  expect((await verifyIdentity(other.accessToken, replacement)).status).toBe(401);
  await prisma.mobileSession.update({ where: { id: other.sessionId }, data: { createdAt: new Date(Date.now() - 11 * 60000) } });
  expect((await post("auth/request-identity-code", { purpose: "LINK_EMAIL", target: "fresh@example.test" }, other.accessToken)).status).toBe(401);
  expect((await prisma.mobilePhoneIdentity.findFirstOrThrow()).phone).toBe(c.phone);
});
it("lost-phone recovery creates one review case, preserves identity and cannot be replayed into authority", async () => {
  const c = await phoneLogin(); await linkEmail(c.accessToken, "recovery@example.test");
  const before = await prisma.mobilePhoneIdentity.findFirstOrThrow();
  const id = await identityChallenge(c.accessToken, "RECOVERY", "+12025550102"), response = await verifyIdentity(c.accessToken, id);
  expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({ outcome: "REVIEW_REQUIRED", requiresSignIn: false });
  for (let i = 0; i < 3; i++) expect((await verifyIdentity(c.accessToken, id)).status).toBe(401);
  await agePhoneCooldown();
  const repeated = await identityChallenge(c.accessToken, "RECOVERY", "+12025550102");
  expect((await verifyIdentity(c.accessToken, repeated)).status).toBe(200);
  expect(await prisma.mobilePhoneIdentity.findFirst()).toEqual(before);
  expect(await prisma.mobileIdentityRecovery.count()).toBe(1); expect(await prisma.serviceCase.count()).toBe(1);
  expect(await prisma.payment.count()).toBe(0); expect(await prisma.ledgerJournal.count()).toBe(0);
  expect((await get("me", c.accessToken)).status).toBe(200);
});
it("phone-only accounts cannot acquire a hold before linking a verified email", async () => {
  const f = await tenantFixture(); await fixtureJurisdiction(prisma); const c = await phoneLogin();
  const input = { draftId: crypto.randomUUID(), revision: 1, vehicleId: f.vehicle.id, pickupAt: "2056-04-01T12:00:00.000Z", returnAt: "2056-04-02T12:00:00.000Z", extraIds: [] };
  const identity = await prisma.mobilePhoneIdentity.findFirstOrThrow();
  await expect(createOrRefreshHold({ ...input, customerId: identity.userId, pickupAt: new Date(input.pickupAt), returnAt: new Date(input.returnAt) })).rejects.toMatchObject({ status: 409 });
  expect((await post("reservations/hold", input, c.accessToken, crypto.randomUUID())).status).toBe(409);
  expect(await prisma.reservation.count()).toBe(1); expect(await prisma.mobileMutation.count()).toBe(0);
  await linkEmail(c.accessToken, "booking@example.test");
  const key = crypto.randomUUID();
  expect((await post("reservations/hold", input, c.accessToken, key)).status).toBe(200);
  expect(await prisma.reservation.count()).toBe(2);
  await prisma.user.update({ where: { id: identity.userId }, data: { emailVerified: null } });
  expect((await post("reservations/hold", input, c.accessToken, key)).status).toBe(409);
  expect(await prisma.reservation.count()).toBe(2);
});

// Phase 7C: real HTTP handlers and disposable PostgreSQL; only external delivery,
// malware and storage boundaries above are fixtures.
it.each(['removed', 'inactive', 'expired'])('host mobile %s membership blocks every new tenant operation with the same token', async change => {
  const f = await tenantFixture(), id = f.reservation.id;
  for (const c of [f.owner, f.employee]) {
    expect((await get('host/context', c.accessToken)).status).toBe(200);
    expect((await get(`host/vehicles/${f.vehicle.id}`, c.accessToken)).status).toBe(200);
    expect((await get(`host/trips/${id}`, c.accessToken)).status).toBe(200);
  }
  expect((await (await get('host/context', f.employee.accessToken)).json()).data).toMatchObject({ role: 'STAFF', canViewEarnings: false, canManageFleet: false, liveFinanceEnabled: false });
  const window = { startAt: '2055-04-01T00:00:00Z', endAt: '2055-05-01T00:00:00Z' };
  expect((await post(`host/vehicles/${f.vehicle.id}/calendar`, window, f.employee.accessToken)).status).toBe(200);
  expect((await post(`host/vehicles/${f.vehicle.id}/availability`, { action: 'availability', isBookable: false }, f.employee.accessToken, crypto.randomUUID())).status).toBe(403);
  if (change === 'removed') await prisma.hostEmployee.delete({ where: { id: f.membership.id } });
  else await prisma.hostEmployee.update({ where: { id: f.membership.id }, data: change === 'inactive' ? { isActive: false } : { expiresAt: new Date(0) } });
  for (const path of ['host/context', `host/vehicles/${f.vehicle.id}`, `host/trips/${id}`]) expect((await get(path, f.employee.accessToken)).status).toBe(403);
  expect((await post(`host/vehicles/${f.vehicle.id}/calendar`, window, f.employee.accessToken)).status).toBe(403);
  expect((await post(`host/trips/${id}/handoff`, { licenseMatchesUpload: false, physicalLicenseUnexpired: false, selfieMatchesCustomer: false }, f.employee.accessToken, crypto.randomUUID())).status).toBe(403);
  expect(await prisma.identityHandoffVerification.count()).toBe(0);
  expect((await get('host/context', f.owner.accessToken)).status).toBe(200);
  expect((await get('host/context', f.customer.accessToken)).status).toBe(403);
  const unrelated = await prisma.user.update({ where: { email: f.other.email }, data: { role: 'HOST' } });
  await prisma.hostProfile.create({ data: { userId: unrelated.id, legalName: 'Other host', onboardingStatus: 'APPROVED' } });
  expect((await get(`host/vehicles/${f.vehicle.id}`, f.other.accessToken)).status).toBe(404);
  expect((await get(`host/trips/${id}`, f.other.accessToken)).status).toBe(404);
});
async function cleanHandoffEvidence(f: Awaited<ReturnType<typeof tenantFixture>>) {
  for (const type of ['LICENSE_FRONT', 'LICENSE_BACK', 'SELFIE_WITH_LICENSE'] as const) await prisma.driverDocument.create({ data: { userId: f.user.id, reservationId: f.reservation.id, type, storageKey: `local:synthetic-${type}.png`, mimeType: 'image/png', fileSizeBytes: 4, contentSha256: 'a'.repeat(64), malwareScanStatus: 'CLEAN', retentionExpiresAt: new Date('2058-01-01') } });
}
const positiveHandoff = { licenseMatchesUpload: true, physicalLicenseUnexpired: true, selfieMatchesCustomer: true };
it('host HTTP handoff requires clean evidence, replays once, and cannot start or unlock a financially blocked trip', async () => {
  const f = await tenantFixture(), path = `host/trips/${f.reservation.id}/handoff`, key = crypto.randomUUID();
  expect((await post(path, positiveHandoff, f.owner.accessToken, key)).status).toBe(409);
  await cleanHandoffEvidence(f);
  for (let i = 0; i < 2; i++) expect((await post(path, positiveHandoff, f.owner.accessToken, key)).status).toBe(200);
  expect(await prisma.identityHandoffVerification.count()).toBe(1);
  expect(await prisma.tripEvent.count({ where: { type: 'IDENTITY_HANDOFF_RECORDED' } })).toBe(1);
  expect((await post(`reservations/${f.reservation.id}/start`, {}, f.owner.accessToken, crypto.randomUUID())).status).toBe(404);
  expect((await post(`reservations/${f.reservation.id}/keys`, {}, f.owner.accessToken, crypto.randomUUID())).status).toBe(409);
  expect(await prisma.tripChecklist.count()).toBe(0); expect(await prisma.trip.count()).toBe(0);
  expect(await prisma.reservation.findUnique({ where: { id: f.reservation.id } })).toMatchObject({ status: 'CONFIRMED', financialDisposition: 'OPEN' });
  expect(await prisma.financialOperation.count()).toBe(0);
  await prisma.driverDocument.updateMany({ data: { malwareScanStatus: 'QUARANTINED' } });
  expect((await post(path, positiveHandoff, f.employee.accessToken, crypto.randomUUID())).status).toBe(409);
});
it('host calendar blocks preserve overlap guards and receipt idempotency', async () => {
  const f = await tenantFixture(), path = `host/vehicles/${f.vehicle.id}/availability`;
  const body = { action: 'block', startAt: '2055-04-01T12:00:00Z', endAt: '2055-04-02T12:00:00Z', reason: 'MAINTENANCE', notes: '' };
  expect((await post(path, body, f.owner.accessToken, crypto.randomUUID())).status).toBe(409);
  const safe = { ...body, startAt: '2055-04-03T12:00:00Z', endAt: '2055-04-04T12:00:00Z' }, key = crypto.randomUUID();
  for (let i = 0; i < 2; i++) expect((await post(path, safe, f.owner.accessToken, key)).status).toBe(200);
  expect(await prisma.vehicleBlock.count()).toBe(1);
  const window = { startAt: '2055-04-01T00:00:00Z', endAt: '2055-05-01T00:00:00Z' };
  const response = await post(`host/vehicles/${f.vehicle.id}/calendar`, window, f.employee.accessToken); expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ blocks: [{ reason: 'MAINTENANCE' }], reservations: [{ id: f.reservation.id }], truncated: false });
});
it.each(['identity', 'condition'])('host private %s read fails closed when membership is revoked during storage IO', async kind => {
  const f = await tenantFixture(); let path: string, capability: string | undefined;
  if (kind === 'identity') {
    await cleanHandoffEvidence(f); const doc = await prisma.driverDocument.findFirstOrThrow(); path = 'files/' + doc.id;
    capability = (await (await post('files/access', { documentId: doc.id }, f.employee.accessToken)).json()).data.capability;
  } else {
    const key = 'local:barrier.png'; await prisma.privateObject.create({ data: { key, sha256: 'a'.repeat(64), size: 4, mimeType: 'image/png', state: 'CLEAN', writeState: 'STORED' } });
    const report = await prisma.conditionReport.create({ data: { reservationId: f.reservation.id, phase: 'PRE_TRIP', submittedByRole: 'HOST', submittedById: f.membership.userId, mileage: 100, fuelLevel: 50, photos: { create: { category: 'EXTERIOR', storageKey: key } } }, include: { photos: true } });
    path = `reservations/${f.reservation.id}/reports/${report.id}/photos/${report.photos[0].id}`;
  }
  const entered = deferred<void>(), release = deferred<void>();
  fixture.storageRead.mockImplementation(async () => { entered.resolve(); await release.promise; return { buffer: Buffer.from('PRIVATE_SENTINEL') }; });
  const pending = fetch(base + '/api/v1/mobile/' + path, { headers: { authorization: 'Bearer ' + f.employee.accessToken, ...(capability ? { 'x-file-access': capability } : {}) } });
  await entered.promise;
  try { await prisma.hostEmployee.delete({ where: { id: f.membership.id } }); } finally { release.resolve(); }
  const result = await pending; expect(result.status).toBe(403); expect(await result.text()).not.toContain('PRIVATE_SENTINEL');
  expect(fixture.storageRead).toHaveBeenCalledTimes(1);
});
it('host concurrent return uses independent connections and a reservation-lock barrier, committing the transition once', async () => {
  const { tripCommand } = await import('@/lib/trip-experience');
  const f = await tenantFixture(); await prisma.reservation.update({ where: { id: f.reservation.id }, data: { status: 'ACTIVE' } });
  const [a, b] = await independentClients(), barrier = deferred<void>(); let arrivals = 0;
  const wrap = (db: PrismaClient) => { let arrived = false; return db.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
    if (!arrived && operation === '$queryRaw' && JSON.stringify(args).includes('release-control')) { arrived = true; if (++arrivals === 2) barrier.resolve(); await barrier.promise; } return query(args);
  } } }) as unknown as PrismaClient; };
  try {
    await Promise.all([tripCommand(f.host.userId, f.reservation.id, 'return', wrap(a)), tripCommand(f.membership.userId, f.reservation.id, 'return', wrap(b))]);
    expect(arrivals).toBe(2); expect(await prisma.tripEvent.count({ where: { type: 'TRIP_RETURN' } })).toBe(1);
    expect(await prisma.reservation.findUnique({ where: { id: f.reservation.id } })).toMatchObject({ status: 'RETURN_IN_PROGRESS' });
    expect(await prisma.financialOperation.count()).toBe(0);
  } finally { await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it('host handoff waiting behind return sees the committed phase and cannot attest after pickup closed', async () => {
  const { tripCommand } = await import('@/lib/trip-experience'), { recordIdentityHandoff } = await import('@/lib/identity-handoff');
  const f = await tenantFixture(); await cleanHandoffEvidence(f); await prisma.reservation.update({ where: { id: f.reservation.id }, data: { status: 'ACTIVE' } });
  const [a, b] = await independentClients(), held = deferred<void>(), release = deferred<void>(), waiting = deferred<void>();
  const first = a.$extends({ query: { reservation: { async updateMany({ args, query }) { const value = await query(args); held.resolve(); await release.promise; return value; } } } }) as unknown as PrismaClient;
  const second = b.$extends({ query: { $allOperations: async ({ operation, args, query }) => { if (operation === '$queryRaw' && JSON.stringify(args).includes('vehicle:')) waiting.resolve(); return query(args); } } }) as unknown as PrismaClient;
  try {
    const returning = tripCommand(f.host.userId, f.reservation.id, 'return', first); await held.promise;
    const handoff = recordIdentityHandoff(f.membership.userId, f.reservation.id, positiveHandoff, second); const rejected = expect(handoff).rejects.toThrow('Pickup phase is closed');
    await waiting.promise; release.resolve(); await returning; await rejected;
    expect(await prisma.identityHandoffVerification.count()).toBe(0); expect(await prisma.tripEvent.count({ where: { type: 'TRIP_RETURN' } })).toBe(1);
  } finally { release.resolve(); await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
it('interrupted support reply freezes its version across refreshed case state and HTTP replay commits exactly one reply', async () => {
  const { PendingReply } = await import('../packages/mobile-client/src/pending-reply');
  const f = await tenantFixture();
  const opened = await post('cases', { kind: 'TICKET', reservationId: f.reservation.id, category: 'GENERAL', title: 'Synthetic recovery', body: 'Synthetic interrupted support reply.' }, f.owner.accessToken, crypto.randomUUID()); expect(opened.status).toBe(200);
  const { id } = (await opened.json()).data;
  const initial = (await (await get('cases/' + id, f.owner.accessToken)).json()).data;
  let drop = true; const requests: string[] = [];
  const client = createMobileClient({ baseUrl: base, allowLocalHttp: true, accessToken: async () => f.owner.accessToken, fetch: async (url, init) => {
    requests.push(String(init?.body)); const response = await fetch(url, init);
    if (drop) { drop = false; expect(response.status).toBe(200); await response.arrayBuffer(); throw new TypeError('Synthetic response lost after database commit'); }
    return response;
  } });
  const pending = new PendingReply(), key = crypto.randomUUID();
  const send = (input: { id: string; body: string; version: number }) => client.call('replyCase', { params: { id: input.id }, body: { body: input.body, version: input.version }, idempotencyKey: key });
  await expect(pending.send({ id, body: 'One synthetic reply', version: initial.version }, send)).rejects.toThrow('Synthetic response lost');
  expect(pending.pending).toBe(true);
  const current = (await (await get('cases/' + id, f.owner.accessToken)).json()).data; expect(current.version).toBe(initial.version + 1);
  await pending.send({ id, body: 'One synthetic reply', version: current.version }, send);
  expect(pending.pending).toBe(false); expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]);
  expect(await prisma.serviceCaseEvent.count({ where: { caseId: id, body: 'One synthetic reply' } })).toBe(1);
  expect(await prisma.mobileMutation.count({ where: { operation: 'case.reply' } })).toBe(1);
});

function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it('host interrupted inspection upload resumes one durable intent, and another author cannot accept the report', async () => {
  const f = await tenantFixture(), photos: Array<{ uploadId: string; category: 'EXTERIOR' | 'INTERIOR' }> = [];
  for (const [index, category] of (['EXTERIOR', 'INTERIOR'] as const).entries()) {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: index ? 'blue' : 'red' } }).png().toBuffer();
    const input = { reservationId: f.reservation.id, type: 'INSPECTION', mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }, initKey = crypto.randomUUID();
    const initialized = await post('uploads', input, f.employee.accessToken, initKey); expect(initialized.status).toBe(200); const id = (await initialized.json()).data.id;
    const key = crypto.randomUUID(), send = () => fetch(base + `/api/v1/mobile/uploads/${id}/finalize`, { method: 'POST', headers: { authorization: 'Bearer ' + f.employee.accessToken, 'content-type': 'image/png', 'idempotency-key': key }, body: new Uint8Array(bytes) });
    if (!index) { fixture.storageWrite.mockRejectedValueOnce(new Error('Synthetic interrupted storage write')); expect((await send()).status).toBe(500); }
    expect((await send()).status).toBe(200); expect((await send()).status).toBe(200);
    expect((await (await post('uploads', input, f.employee.accessToken, initKey)).json()).data.id).toBe(id);
    photos.push({ uploadId: id, category });
  }
  expect(await prisma.mobileUpload.count()).toBe(2); expect(await prisma.privateObject.count()).toBe(2); expect(await prisma.driverDocument.count()).toBe(0);
  expect(fixture.storageWrite).toHaveBeenCalledTimes(3); expect(fixture.scan).toHaveBeenCalledTimes(3);
  const key = crypto.randomUUID(), path = `reservations/${f.reservation.id}/reports`, body = { phase: 'PRE_TRIP', mileage: 100, fuelLevel: 50, photos };
  const response = await post(path, body, f.employee.accessToken, key); expect(response.status).toBe(200); const { id } = (await response.json()).data;
  expect((await post(path, body, f.employee.accessToken, key)).status).toBe(200);
  expect((await post(path + '/' + id + '/accept', {}, f.owner.accessToken, crypto.randomUUID())).status).toBe(403);
  expect((await post(path + '/' + id + '/accept', {}, f.employee.accessToken, crypto.randomUUID())).status).toBe(200);
  expect(await prisma.conditionReport.count()).toBe(1); expect(await prisma.conditionPhoto.count()).toBe(2);
  const own = (await (await get(path, f.employee.accessToken)).json()).data.items[0]; expect(own.own).toBe(true);
  const owner = (await (await get(path, f.owner.accessToken)).json()).data.items[0]; expect(owner.own).toBe(false);
});
it.each(['revoke', 'handoff'] as const)('host membership race: %s commits first at the shared User lock', async first => {
  const { hostCommand } = await import('@/lib/marketplace'), { recordIdentityHandoff } = await import('@/lib/identity-handoff');
  const f = await tenantFixture(); await cleanHandoffEvidence(f);
  const [a, b] = await independentClients(), locked = signal(), release = signal(); let stopped = false;
  const [winnerPid] = await a.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const [waiterPid] = await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const fenced = a.$extends({ query: { $allOperations: async ({ operation, args, query }) => {
    const result = await query(args);
    if (!stopped && operation === '$queryRaw' && JSON.stringify(args).includes('User') && JSON.stringify(args).includes('FOR UPDATE')) { stopped = true; locked.resolve(); await release.promise; }
    return result;
  } } }) as unknown as PrismaClient;
  const revoke = (db: PrismaClient) => hostCommand(f.host.userId, { action: 'removeEmployee', id: f.membership.id }, db);
  const handoff = (db: PrismaClient) => recordIdentityHandoff(f.membership.userId, f.reservation.id, positiveHandoff, db);
  const winner = (first === 'revoke' ? revoke : handoff)(fenced);
  let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await locked.promise;
    results = Promise.allSettled([winner, (first === 'revoke' ? handoff : revoke)(b)]);
    let blocked = false; const deadline = Date.now() + 4000;
    while (!blocked && Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${winnerPid.pid}::int = ANY(pg_blocking_pids(${waiterPid.pid}::int)) AS blocked`;
      blocked = row.blocked;
    }
    expect(blocked).toBe(true); release.resolve(); const outcomes = await results;
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe(first === 'revoke' ? 'rejected' : 'fulfilled');
    expect(await prisma.hostEmployee.count()).toBe(0);
    expect(await prisma.identityHandoffVerification.count()).toBe(first === 'handoff' ? 1 : 0);
    expect(await prisma.tripEvent.count({ where: { type: 'IDENTITY_HANDOFF_RECORDED' } })).toBe(first === 'handoff' ? 1 : 0);
    expect((await get(`host/trips/${f.reservation.id}`, f.employee.accessToken)).status).toBe(403);
    expect((await post(`host/trips/${f.reservation.id}/handoff`, positiveHandoff, f.employee.accessToken, crypto.randomUUID())).status).toBe(403);
    expect(await prisma.financialOperation.count()).toBe(0); expect(await prisma.mobileSession.count()).toBe(4);
  } finally { release.resolve(); await Promise.allSettled([winner, ...(results ? [results] : [])]); await Promise.all([a.$disconnect(), b.$disconnect()]); }
});
