import { createServer } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma, createTestCustomer, createTestReservation, createTestVehicle, cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { executeDepositReleaseOperation, executeDepositOperation } from "@/lib/deposit-authorization";
import { recoverDeposits } from "@/lib/financial-workers";
import { withReservationLock } from "@/lib/financial-locks";
import { quarantineOperation } from "@/lib/financial-cases";
import { prepareOperation } from "@/lib/financial-operations";
import { getOrCreateRefundOperation, executeRefundOperation } from "@/lib/refund-operations";
import { prisma as workerDb } from "@/lib/prisma";
import { POST } from "@/app/api/cron/financial/[worker]/route";
const provider = vi.hoisted(() => ({ paymentIntents: { retrieve: vi.fn(), cancel: vi.fn(), create: vi.fn(), list: vi.fn() }, refunds: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ stripe: provider }));
const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("connection_limit", "1");
const other = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const vehicles: string[] = [], users: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const group of Object.values(provider)) for (const mock of Object.values(group)) mock.mockReset(); vi.unstubAllEnvs(); });
afterAll(async () => { await cleanupReservationsForVehicles(vehicles); await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await other.$disconnect(); await prisma.$disconnect(); });
async function fixture(terminated = true) {
  const v = await createTestVehicle(), u = await createTestCustomer(); vehicles.push(v.id); users.push(u.id);
  const r = await createTestReservation({ vehicleId: v.id, customerId: u.id, pickupAt: new Date("2040-01-01"), returnAt: new Date("2040-01-03"), status: terminated ? "CANCELLED_BY_CUSTOMER" : "CONFIRMED", depositCents: 15000 });
  if (terminated) await prisma.reservation.update({ where: { id: r.id }, data: { financialDisposition: "TERMINATED" } });
  const intentId = "pi_guard_" + randomUUID();
  const original = await withReservationLock(r.id, tx => prepareOperation(tx, { key: "deposit:" + r.id, kind: "DEPOSIT", reservationId: r.id, payload: { amount: 15000, currency: "usd", customer: "cus_test" } }));
  await prisma.financialOperation.update({ where: { id: original.id }, data: { providerId: intentId, generation: 1, state: "OBSERVED" } });
  await prisma.securityDeposit.create({ data: { reservationId: r.id, amountCents: 15000, operationId: original.id, stripePaymentIntentId: intentId, generation: 1 } });
  const release = await withReservationLock(r.id, tx => prepareOperation(tx, { key: "deposit-release:" + intentId, kind: "DEPOSIT_RELEASE", reservationId: r.id, payload: { intentId } }));
  let remote = { id: intentId, status: "requires_capture", amount: 15000, currency: "usd", amount_capturable: 15000, created: 1, latest_charge: { created: 1, payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 3600 } } } };
  const ledger = new Map<string, string>();
  provider.paymentIntents.retrieve.mockImplementation(async () => remote);
  provider.paymentIntents.cancel.mockImplementation(async (id, _, options) => { expect(id).toBe(intentId); ledger.set(options.idempotencyKey, id); remote = { ...remote, status: "canceled" }; return remote; });
  return { r, release, original: await prisma.financialOperation.findUniqueOrThrow({ where: { id: original.id } }), intentId, ledger, remote: () => remote };
}
async function waitLock(pid: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ wait_event_type: string }>>`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Expected independent PostgreSQL session to block on guard");
}
async function quarantine(reservationId: string, id: string) {
  return withReservationLock(reservationId, async tx => {
    await tx.financialOperation.update({ where: { id }, data: { state: "REVIEW", leaseToken: null, leaseExpiresAt: null } });
    await quarantineOperation(tx, id, "ADVERSARIAL_QUARANTINE");
  }, other);
}
describe("Phase 1 cross-instance dispatch guard", () => {
  it("takes over during retrieval: stale worker calls zero times and successor calls exactly once", async () => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    provider.paymentIntents.retrieve.mockImplementationOnce(async () => { const staleCapture = f.remote(); entered.release(); await resume.wait; return staleCapture; });
    const stale = executeDepositReleaseOperation(f.release); await entered.wait;
    await withReservationLock(f.r.id, tx => tx.financialOperation.update({ where: { id: f.release.id }, data: { leaseExpiresAt: new Date(0) } }), other);
    expect(await executeDepositReleaseOperation(f.release)).toMatchObject({ status: "processed" });
    const successor = await prisma.financialOperation.findUniqueOrThrow({ where: { id: f.release.id } });
    resume.release(); expect(await stale).toMatchObject({ status: "processed" });
    expect(await prisma.financialOperation.findUniqueOrThrow({ where: { id: f.release.id } })).toEqual(successor);
    expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1); expect(f.ledger.size).toBe(1);
  });
  it.each(["expired", "replaced", "quarantine", "blocked"])("%s wins during retrieval and prevents dispatch", async mode => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    provider.paymentIntents.retrieve.mockImplementation(async () => { entered.release(); await resume.wait; return f.remote(); });
    const running = executeDepositReleaseOperation(f.release); await entered.wait;
    if (mode === "quarantine") await quarantine(f.r.id, f.release.id);
    else await withReservationLock(f.r.id, async tx => {
      if (mode === "blocked") await tx.providerObjectOwnership.update({ where: { providerId: f.intentId }, data: { kind: "BLOCKED" } });
      else await tx.financialOperation.update({ where: { id: f.release.id }, data: mode === "expired" ? { leaseExpiresAt: new Date(0) } : { leaseToken: "successor", leaseExpiresAt: new Date(Date.now() + 120000) } });
    }, other);
    resume.release(); const result = await running;
    expect(result.status).toBe(["quarantine", "blocked"].includes(mode) ? "quarantined" : "failed");
    expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
    if (mode === "replaced") expect((await prisma.financialOperation.findUniqueOrThrow({ where: { id: f.release.id } })).leaseToken).toBe("successor");
    if (mode === "blocked") expect(await prisma.financialCase.count({ where: { operationId: f.release.id } })).toBe(1);
  });
  it("dispatch wins: quarantine waits on a separate session and records durable dispatch evidence", async () => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    const cancel = provider.paymentIntents.cancel.getMockImplementation()!;
    provider.paymentIntents.cancel.mockImplementation(async (...args) => { entered.release(); await resume.wait; return cancel(...args); });
    const running = executeDepositReleaseOperation(f.release); await entered.wait;
    const [{ pid }] = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const blocked = quarantine(f.r.id, f.release.id);
    try { await waitLock(pid); expect(await prisma.financialDispatch.count({ where: { operationId: f.release.id, phase: "DISPATCHED" } })).toBe(1); }
    finally { resume.release(); }
    await Promise.all([running, blocked]);
    const c = await prisma.financialCase.findFirstOrThrow({ where: { operationId: f.release.id } });
    expect(c.evidence).toMatchObject({ dispatches: expect.arrayContaining([expect.objectContaining({ phase: "DISPATCHED" }), expect.objectContaining({ phase: "SUCCEEDED" })]) });
    expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  });
  it("database trigger rejects a bypass writer while dispatch owns the session guard", async () => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    provider.paymentIntents.cancel.mockImplementation(async () => { entered.release(); await resume.wait; return { ...f.remote(), status: "canceled" }; });
    const running = executeDepositReleaseOperation(f.release); await entered.wait;
    try { await expect(other.providerObjectOwnership.update({ where: { providerId: f.intentId }, data: { kind: "BLOCKED" } })).rejects.toThrow(); }
    finally { resume.release(); }
    await running;
  });
  it("two application instances contend while a provider request is live: one ledger dispatch", async () => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    const cancel = provider.paymentIntents.cancel.getMockImplementation()!;
    provider.paymentIntents.cancel.mockImplementation(async (...args) => { entered.release(); await resume.wait; return cancel(...args); });
    const first = executeDepositReleaseOperation(f.release); await entered.wait;
    const second = executeDepositReleaseOperation(f.release);
    // Observe the second application's actual advisory-lock waiter, not a sleep.
    const deadline = Date.now() + 4000;
    try { while (true) { const rows = await other.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`; if (Number(rows[0].n) > 0) break; if (Date.now() > deadline) throw new Error("No competing worker"); await new Promise(r => setTimeout(r, 5)); } }
    finally { resume.release(); }
    await Promise.all([first, second]); expect(f.ledger.size).toBe(1); expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  });
  it("recovers acceptance followed by lost response using the same target/key and one effect", async () => {
    const f = await fixture(); const cancel = provider.paymentIntents.cancel.getMockImplementation()!;
    provider.paymentIntents.cancel.mockImplementationOnce(async (...args) => { await cancel(...args); throw new Error("Connection lost after acceptance"); });
    expect(await executeDepositReleaseOperation(f.release)).toMatchObject({ status: "uncertain" });
    expect(await prisma.financialDispatch.count({ where: { operationId: f.release.id, phase: "UNCERTAIN" } })).toBe(1);
    expect(await executeDepositReleaseOperation(f.release)).toMatchObject({ status: "processed" });
    expect(f.ledger).toEqual(new Map([[f.release.key, f.intentId]])); expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1);
    expect(provider.paymentIntents.retrieve).toHaveBeenLastCalledWith(f.intentId);
  });
  it.each([false, true])("counts a late authorization's newly discovered release once (HTTP=%s)", async http => {
    const f = await fixture(); await prisma.financialOperation.delete({ where: { id: f.release.id } });
    await prisma.financialOperation.update({ where: { id: f.original.id }, data: { state: "RETRY", firstAttemptAt: new Date() } });
    let result;
    if (http) {
      vi.stubEnv("CRON_SECRET", "phase1-test");
      const server = createServer(async (req, res) => {
        const response = await POST(new NextRequest("http://localhost/api/cron/financial/deposits", { method: "POST", headers: { authorization: req.headers.authorization ?? "" } }), { params: Promise.resolve({ worker: "deposits" }) });
        res.writeHead(response.status, { "content-type": "application/json" }); res.end(await response.text());
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try { const address = server.address(); if (!address || typeof address === "string") throw new Error("Listener missing");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/cron/financial/deposits`, { method: "POST", headers: { authorization: "Bearer phase1-test" } }); expect(response.status).toBe(200); result = await response.json();
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
    else result = await recoverDeposits();
    expect(result.releases).toEqual({ processed: 1, failed: 0, quarantined: 0, uncertain: 0 });
    expect(result.releaseOperations).toHaveLength(1); expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["REFUND", "DEPOSIT"])("%s dispatch excludes quarantine until provider acceptance is durable", async kind => {
    const f = await fixture(false); await prisma.financialOperation.delete({ where: { id: f.release.id } });
    let operation = f.original, execute: () => Promise<unknown>;
    const entered = barrier(), resume = barrier();
    if (kind === "REFUND") {
      const p = await prisma.payment.create({ data: { reservationId: f.r.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: "pi_rental_" + f.r.id } });
      const refund = await getOrCreateRefundOperation({ reservationId: f.r.id, paymentId: p.id, amountCents: 1000, idempotencyKey: "refund:" + f.r.id });
      operation = await prisma.financialOperation.findUniqueOrThrow({ where: { key: refund.idempotencyKey } });
      provider.refunds.create.mockImplementation(async () => { entered.release(); await resume.wait; return { id: "re_" + f.r.id, status: "succeeded" }; });
      execute = () => executeRefundOperation(refund.id, p.stripePaymentIntentId);
    } else {
      await prisma.providerObjectOwnership.delete({ where: { providerId: f.intentId } });
      operation = await prisma.financialOperation.update({ where: { id: operation.id }, data: { providerId: null, state: "READY" } });
      provider.paymentIntents.create.mockImplementation(async () => { entered.release(); await resume.wait; return f.remote(); });
      execute = () => executeDepositOperation(operation);
    }
    const running = execute(); await entered.wait;
    const [{ pid }] = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const blocked = quarantine(f.r.id, operation.id);
    try { await waitLock(pid); } finally { resume.release(); }
    await Promise.all([running, blocked]);
    expect(await prisma.financialDispatch.count({ where: { operationId: operation.id, phase: "SUCCEEDED" } })).toBe(1);
    expect((await prisma.financialCase.findFirstOrThrow({ where: { operationId: operation.id } })).evidence).toMatchObject({ dispatches: expect.arrayContaining([expect.objectContaining({ phase: "DISPATCHED" })]) });
  });

  it.each(["REFUND", "DEPOSIT"].flatMap(kind => ["expired", "replaced", "quarantine", "authority"].map(mode => [kind, mode])))("%s/%s wins after real claim and before dispatch", async (kind, mode) => {
    const f = await fixture(false), entered = barrier(), resume = barrier();
    await prisma.financialOperation.delete({ where: { id: f.release.id } });
    let operation = f.original, execute: () => Promise<unknown>, rentalId: string | undefined;
    if (kind === "REFUND") {
      rentalId = "pi_stale_" + f.r.id;
      const payment = await prisma.payment.create({ data: { reservationId: f.r.id, type: "RENTAL", status: "SUCCEEDED", amountCents: 15000, stripePaymentIntentId: rentalId } });
      const refund = await getOrCreateRefundOperation({ reservationId: f.r.id, paymentId: payment.id, amountCents: 1000, idempotencyKey: "stale-refund:" + f.r.id });
      operation = await prisma.financialOperation.findUniqueOrThrow({ where: { key: refund.idempotencyKey } });
      execute = () => executeRefundOperation(refund.id, payment.stripePaymentIntentId);
    } else {
      await prisma.providerObjectOwnership.delete({ where: { providerId: f.intentId } });
      operation = await prisma.financialOperation.update({ where: { id: operation.id }, data: { providerId: null, state: "READY" } });
      execute = () => executeDepositOperation(operation);
    }
    // Pause a real DB read after the real claim commits. No financial service,
    // claim, guard or provider-dispatch implementation is replaced.
    const read = workerDb.reservation.findUniqueOrThrow.bind(workerDb.reservation);
    vi.spyOn(workerDb.reservation, "findUniqueOrThrow").mockImplementationOnce((async (args: Parameters<typeof read>[0]) => {
      const value = await read(args); entered.release(); await resume.wait; return value;
    }) as never);
    const running = execute(), rejected = expect(running).rejects.toThrow(); await entered.wait;
    expect((await prisma.financialOperation.findUniqueOrThrow({ where: { id: operation.id } })).state).toBe("RUNNING");
    if (mode === "quarantine") await quarantine(f.r.id, operation.id);
    else await withReservationLock(f.r.id, async tx => {
      if (mode === "authority") {
        if (rentalId) await tx.providerObjectOwnership.update({ where: { providerId: rentalId }, data: { kind: "BLOCKED" } });
        else await tx.securityDeposit.update({ where: { reservationId: f.r.id }, data: { generation: { increment: 1 } } });
      } else await tx.financialOperation.update({ where: { id: operation.id }, data: mode === "expired" ? { leaseExpiresAt: new Date(0) } : { leaseToken: "successor", leaseExpiresAt: new Date(Date.now() + 120000) } });
    }, other);
    resume.release(); await rejected;
    expect(provider.refunds.create).not.toHaveBeenCalled(); expect(provider.paymentIntents.create).not.toHaveBeenCalled();
    const saved = await prisma.financialOperation.findUniqueOrThrow({ where: { id: operation.id } });
    if (mode === "replaced") expect(saved.leaseToken).toBe("successor");
    if (mode === "authority") { expect(saved.state).toBe("REVIEW"); expect(await prisma.financialCase.count({ where: { operationId: operation.id } })).toBe(1); }
  });
  it("retains acceptance evidence across a real projection transaction failure and recovers without a second cancellation", async () => {
    const f = await fixture(); const trigger = "test_release_crash_" + f.r.id;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."reservationId"='${f.r.id}' AND NEW."status"='CANCELLED' THEN RAISE EXCEPTION 'Injected projection crash'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "SecurityDeposit" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      expect(await executeDepositReleaseOperation(f.release)).toMatchObject({ status: "uncertain" });
      expect(await prisma.financialDispatch.count({ where: { operationId: f.release.id, phase: "SUCCEEDED" } })).toBe(1);
      expect((await prisma.financialOperation.findUniqueOrThrow({ where: { id: f.release.id } })).providerId).toBe(f.intentId);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "SecurityDeposit"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    expect(await executeDepositReleaseOperation(f.release)).toMatchObject({ status: "processed" });
    expect(f.ledger.size).toBe(1); expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1);
    expect((await prisma.securityDeposit.findUniqueOrThrow({ where: { reservationId: f.r.id } })).status).toBe("CANCELLED");
  });

});
