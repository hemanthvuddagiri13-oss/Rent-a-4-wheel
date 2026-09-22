import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
const fixture = vi.hoisted(() => ({ name: "mobile_" + crypto.randomUUID().replaceAll("-", "") + "_test", emails: [] as string[] }));
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!); url.pathname = "/" + fixture.name;
  return { prisma: new PrismaClient({ datasources: { db: { url: url.toString() } } }) };
});
// Only the external email delivery boundary is replaced; codes, auth, HTTP,
// sessions, domain transactions and locks all execute against real PostgreSQL.
vi.mock("@/lib/email", () => ({ sendEmail: async ({ html }: { html: string }) => { fixture.emails.push(html); return { sent: true }; } }));
import { prisma } from "@/lib/prisma";
import { POST as authPost, GET as authGet } from "@/app/api/v1/mobile/auth/[action]/route";
import { POST as apiPost, GET as apiGet } from "@/app/api/v1/mobile/[...path]/route";
import { refreshMobileCredential, tokenHash } from "@/lib/mobile/auth";
import { mobileMutation } from "@/lib/mobile/mutation";

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
