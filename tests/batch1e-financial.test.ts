import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { withReservationLock } from "@/lib/financial-locks";
import { getOrCreateRefundOperation, executeRefundOperation, reconcileRefundStatus } from "@/lib/refund-operations";
import { dueOperations, recoverRefunds } from "@/lib/financial-workers";
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { syncDepositIntent } from "@/lib/deposit-authorization";
const provider = vi.hoisted(() => ({ refunds: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() }, paymentIntents: { retrieve: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ stripe: provider }));
const vehicles: string[] = [], users: string[] = [];
const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("connection_limit", "1");
const a = new PrismaClient({ datasources: { db: { url: url.toString() } } }), b = new PrismaClient({ datasources: { db: { url: url.toString() } } });
afterEach(() => { for (const group of Object.values(provider)) for (const fn of Object.values(group)) fn.mockReset(); });
afterAll(async () => { await cleanupReservationsForVehicles(vehicles); await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } }); await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await Promise.all([a.$disconnect(), b.$disconnect(), prisma.$disconnect()]); });
async function fixture(bound = true) {
  const v = await createTestVehicle(), u = await createTestCustomer({ stripeCustomerId: "cus_" + randomUUID() }); vehicles.push(v.id); users.push(u.id);
  const r = await createTestReservation({ vehicleId: v.id, customerId: u.id, pickupAt: new Date("2038-01-01"), returnAt: new Date("2038-01-03"), status: "CONFIRMED", depositCents: 15000 });
  const p = await prisma.payment.create({ data: { reservationId: r.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: bound ? "pi_r_" + r.id : null, idempotencyKey: "rental-" + r.id } });
  await prisma.securityDeposit.create({ data: { reservationId: r.id, amountCents: 15000 } });
  return { r, p, u };
}
async function waitForLock(pid: number) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const rows = await prisma.$queryRaw<Array<{ wait_event_type: string }>>`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Second database connection did not contend on the lock");
}
describe("Batch 1E financial boundaries", () => {
  it("terminalizes 25 polls through real reconciliation and executes later work in one real recovery invocation", async () => {
    const { r, p } = await fixture(); const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const f = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: randomUUID() }); ids.push(f.id);
      provider.refunds.create.mockResolvedValueOnce({ id: "re_" + f.id, status: "pending" });
      await executeRefundOperation(f.id, p.stripePaymentIntentId);
      await prisma.financialOperation.update({ where: { key: f.idempotencyKey }, data: { nextAttemptAt: new Date(0) } });
    }
    for (let i = 0; i < ids.length; i++) {
      provider.refunds.retrieve.mockResolvedValueOnce({ id: "re_" + ids[i], status: ["succeeded", "failed", "canceled"][i % 3] });
      await reconcileRefundStatus("re_" + ids[i], "pending");
    }
    const later = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: randomUUID() });
    expect(await prisma.financialOperation.count({ where: { reservationId: r.id, state: "POLL" } })).toBe(0);
    // Even an old/unprojected terminal operation cannot fill the SQL limit.
    await prisma.financialOperation.updateMany({ where: { reservationId: r.id, state: "OBSERVED" }, data: { state: "POLL", nextAttemptAt: new Date(0) } });
    expect((await dueOperations("REFUND")).filter(o => o.reservationId === r.id).map(o => o.key)).toEqual([later.idempotencyKey]);
    provider.refunds.create.mockResolvedValueOnce({ id: "re_" + later.id, status: "succeeded" });
    expect(await recoverRefunds()).toEqual({ processed: 1, pending: 0 });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: later.id } })).status).toBe("SUCCEEDED");
    expect(await recoverRefunds()).toEqual({ processed: 0, pending: 0 });
  });
  it("fences an in-flight stale refund observation after authoritative terminal reconciliation", async () => {
    const { r, p } = await fixture(), entered = barrier(), release = barrier();
    const f = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: randomUUID() });
    provider.refunds.create.mockResolvedValueOnce({ id: "re_" + f.id, status: "pending" }); await executeRefundOperation(f.id, p.stripePaymentIntentId);
    provider.refunds.retrieve.mockImplementationOnce(async () => { entered.release(); await release.wait; return { id: "re_" + f.id, status: "pending" }; });
    const running = executeRefundOperation(f.id, p.stripePaymentIntentId).catch(e => e); await entered.wait;
    provider.refunds.retrieve.mockResolvedValueOnce({ id: "re_" + f.id, status: "succeeded" }); await reconcileRefundStatus("re_" + f.id, "pending");
    const terminal = await prisma.financialOperation.findUniqueOrThrow({ where: { key: f.idempotencyKey } });
    release.release(); expect(await running).toBeInstanceOf(Error);
    expect(await prisma.financialOperation.findUniqueOrThrow({ where: { id: terminal.id } })).toEqual(terminal);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("SUCCEEDED");
  });
  it.each(["RENTAL", "DEPOSIT"])("rejects inverse %s adoption with identical amounts and preserves every financial record", async kind => {
    const { r, p, u } = await fixture(kind !== "RENTAL"), admin = await createTestCustomer({ role: "ADMIN" }); users.push(admin.id);
    const op = await prisma.financialOperation.create({ data: { key: kind === "RENTAL" ? p.idempotencyKey! : randomUUID(), kind, reservationId: r.id, fingerprint: "test", payload: {}, state: "REVIEW" } });
    const c = await prisma.financialCase.create({ data: { sourceKey: randomUUID(), operationId: op.id, paymentId: kind === "RENTAL" ? p.id : null, reservationId: r.id, customerId: u.id, kind, amountCents: 15000, reason: "Uncertain legacy evidence" } });
    const snapshot = async () => Promise.all([prisma.payment.findMany({ where: { reservationId: r.id } }), prisma.securityDeposit.findUnique({ where: { reservationId: r.id } }), prisma.financialOperation.findMany({ where: { reservationId: r.id } }), prisma.financialCase.findUnique({ where: { id: c.id } })]);
    const before = await snapshot();
    provider.paymentIntents.retrieve.mockResolvedValue({ id: kind === "RENTAL" ? "pi_deposit_" + r.id : p.stripePaymentIntentId, amount: 15000, currency: "usd", customer: u.stripeCustomerId, status: "succeeded", capture_method: kind === "RENTAL" ? "manual" : "automatic", metadata: { reservationId: r.id, purpose: kind === "RENTAL" ? "security_deposit" : "rental", paymentId: p.id, operationKey: op.key } });
    await expect(resolveFinancialCase(admin, { caseId: c.id, action: "ADOPT", providerId: kind === "RENTAL" ? "pi_deposit_" + r.id : p.stripePaymentIntentId!, reason: "Test matching identity with wrong financial purpose" })).rejects.toThrow(kind === "RENTAL" ? "Rental purpose/capture method mismatch" : "Provider identity already belongs to another operation");
    expect(await snapshot()).toEqual(before);
    if (kind === "RENTAL") {
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).stripePaymentIntentId).toBeNull();
      expect(await prisma.providerObjectOwnership.findUnique({ where: { providerId: "pi_deposit_" + r.id } })).toBeNull();
      expect((await prisma.financialCase.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("OPEN");
    }
  });
  it("rejects ambiguous rental lineage and accepts the original payment/operation evidence", async () => {
    const { r, p, u } = await fixture(false), admin = await createTestCustomer({ role: "ADMIN" }); users.push(admin.id);
    const op = await prisma.financialOperation.create({ data: { key: p.idempotencyKey!, kind: "RENTAL", reservationId: r.id, fingerprint: "test", payload: {}, state: "REVIEW" } });
    const c = await prisma.financialCase.create({ data: { sourceKey: randomUUID(), operationId: op.id, paymentId: p.id, reservationId: r.id, customerId: u.id, kind: "RENTAL", amountCents: 15000, reason: "Uncertain rental" } });
    const evidence = { id: "pi_verified_" + r.id, amount: 15000, currency: "usd", customer: u.stripeCustomerId, status: "succeeded", capture_method: "automatic", metadata: { reservationId: r.id } };
    provider.paymentIntents.retrieve.mockResolvedValue(evidence);
    await expect(resolveFinancialCase(admin, { caseId: c.id, action: "ADOPT", providerId: evidence.id, reason: "Reservation alone does not prove original payment" })).rejects.toThrow("Ambiguous");
    provider.paymentIntents.retrieve.mockResolvedValue({ ...evidence, metadata: { ...evidence.metadata, paymentId: p.id, operationKey: op.key } });
    await resolveFinancialCase(admin, { caseId: c.id, action: "ADOPT", providerId: evidence.id, reason: "Verified original payment and immutable operation lineage" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).stripePaymentIntentId).toBe(evidence.id);
  });
  it("a stale refund worker cannot overwrite its successor's active lease or terminal outcome", async () => {
    const { r, p } = await fixture(), entered = barrier(), release = barrier(), successorEntered = barrier(), successorRelease = barrier();
    const f = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: randomUUID() });
    provider.refunds.create.mockResolvedValueOnce({ id: "re_" + f.id, status: "pending" }); await executeRefundOperation(f.id, p.stripePaymentIntentId);
    provider.refunds.retrieve.mockImplementationOnce(async () => { entered.release(); await release.wait; return { id: "re_" + f.id, status: "pending" }; });
    const old = executeRefundOperation(f.id, p.stripePaymentIntentId).catch(e => e); await entered.wait;
    await b.financialOperation.update({ where: { key: f.idempotencyKey }, data: { leaseExpiresAt: new Date(0) } });
    provider.refunds.retrieve.mockImplementationOnce(async () => { successorEntered.release(); await successorRelease.wait; return { id: "re_" + f.id, status: "succeeded" }; });
    const successor = executeRefundOperation(f.id, p.stripePaymentIntentId); await successorEntered.wait;
    const leased = await prisma.financialOperation.findUniqueOrThrow({ where: { key: f.idempotencyKey } });
    release.release(); expect(await old).toBeInstanceOf(Error);
    expect(await prisma.financialOperation.findUniqueOrThrow({ where: { id: leased.id } })).toEqual(leased);
    successorRelease.release(); await successor;
    expect((await prisma.financialOperation.findUniqueOrThrow({ where: { id: leased.id } })).state).toBe("OBSERVED");
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("SUCCEEDED");
  });
  it("verifies unknown release terms only through the bound original authorization lineage", async () => {
    const { r, u } = await fixture(), admin = await createTestCustomer({ role: "ADMIN" }); users.push(admin.id);
    const original = await prisma.financialOperation.create({ data: { key: randomUUID(), kind: "DEPOSIT", reservationId: r.id, providerId: "pi_historical_" + r.id, fingerprint: "legacy", payload: { legacy: true }, state: "REVIEW" } });
    const release = await prisma.financialOperation.create({ data: { key: "deposit-release:" + original.providerId, kind: "DEPOSIT_RELEASE", reservationId: r.id, fingerprint: "release", payload: { intentId: original.providerId }, state: "REVIEW" } });
    const c = await prisma.financialCase.create({ data: { sourceKey: randomUUID(), reservationId: r.id, customerId: u.id, operationId: release.id, kind: "DEPOSIT_RELEASE", amountCents: null, currency: null, reason: "Original authorization amount no longer projected" } });
    const evidence = { id: original.providerId, amount: 15000, currency: "usd", status: "canceled", capture_method: "manual", customer: u.stripeCustomerId, metadata: { reservationId: r.id, purpose: "security_deposit" } };
    provider.paymentIntents.retrieve.mockResolvedValue(evidence);
    await expect(resolveFinancialCase(admin, { caseId: c.id, action: "ADOPT", providerId: original.providerId!, reason: "Reservation-only evidence must remain unknown" })).rejects.toThrow("unknown");
    provider.paymentIntents.retrieve.mockResolvedValue({ ...evidence, metadata: { ...evidence.metadata, operationKey: original.key } });
    await resolveFinancialCase(admin, { caseId: c.id, action: "ADOPT", providerId: original.providerId!, reason: "Exact original authorization identity and provider lineage verified" });
    expect(await prisma.financialCase.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ amountCents: 15000, currency: "usd", status: "VERIFIED" });
    expect(await prisma.financialOperation.count({ where: { reservationId: r.id } })).toBe(2);
  });
  it("database serializes duplicate provider ownership across separate connections", async () => {
    const x = await fixture(), y = await fixture(), gate = barrier(), release = barrier(), pid = (await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid;
    expect((await a.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid).not.toBe(pid);
    const providerId = "pi_race_" + randomUUID();
    const first = a.$transaction(async tx => { await tx.financialOperation.create({ data: { key: randomUUID(), kind: "DEPOSIT", reservationId: x.r.id, providerId, fingerprint: "a", payload: {} } }); gate.release(); await release.wait; });
    await gate.wait;
    const second = b.financialOperation.create({ data: { key: randomUUID(), kind: "RENTAL", reservationId: y.r.id, providerId, fingerprint: "b", payload: {} } }).catch(e => e);
    await waitForLock(pid); release.release(); await first; expect(await second).toBeInstanceOf(Error);
    expect(await prisma.financialOperation.count({ where: { providerId } })).toBe(1);
  });
  it.each([true, false])("persists compensation under actual lock contention, observation first=%s", async observationFirst => {
    const { r } = await fixture(), gate = barrier(), release = barrier();
    const op = await prisma.financialOperation.create({ data: { key: randomUUID(), kind: "DEPOSIT", reservationId: r.id, generation: 1, fingerprint: "x", payload: {}, state: "RUNNING" } });
    await prisma.securityDeposit.update({ where: { reservationId: r.id }, data: { generation: 1, operationId: op.id } });
    const intent = { id: "pi_auth_" + r.id, status: "requires_capture", amount: 15000, amount_capturable: 15000, currency: "usd", latest_charge: { created: 1, payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 3600 } } } };
    const observe = async (tx: Parameters<Parameters<typeof withReservationLock>[1]>[0]) => { await tx.financialOperation.update({ where: { id: op.id }, data: { providerId: intent.id } }); await syncDepositIntent(r.id, intent as never, tx); };
    const cancel = (tx: Parameters<Parameters<typeof withReservationLock>[1]>[0]) => transitionReservation(tx, { id: r.id, from: "CONFIRMED", to: "CANCELLED_BY_CUSTOMER" });
    const pid = (await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid;
    const first = withReservationLock(r.id, async tx => { await (observationFirst ? observe : cancel)(tx); gate.release(); await release.wait; }, a);
    await gate.wait; const second = withReservationLock(r.id, observationFirst ? cancel : observe, b);
    await waitForLock(pid); release.release(); await Promise.all([first, second]);
    const releases = await prisma.financialOperation.findMany({ where: { reservationId: r.id, kind: "DEPOSIT_RELEASE" } });
    expect(releases).toHaveLength(1); expect(releases[0].key).toBe("deposit-release:" + intent.id); expect(releases[0].state).toBe("READY"); expect(releases[0].nextAttemptAt).toBeNull();
  });
});
