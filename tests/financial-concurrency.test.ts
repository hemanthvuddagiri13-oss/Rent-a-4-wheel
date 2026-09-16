import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { barrier } from "./helpers/barrier";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";
import { withReservationLock, eventFence } from "@/lib/financial-locks";
import { prepareOperation, runOperation } from "@/lib/financial-operations";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { handlePaymentIntentSucceeded, handlePaymentIntentFailed } from "@/lib/stripe-webhook-handlers";
import { createOrRefreshHold } from "@/lib/checkout-hold";
import { expireStaleReservations } from "@/lib/cleanup";
import { assertFinancialTripStart } from "@/lib/financial-locks";
import { recoverRefunds } from "@/lib/financial-workers";
import { prisma as workerDb } from "@/lib/prisma";

const provider = vi.hoisted(() => ({ refunds: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() }, paymentIntents: { create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ stripe: provider }));
const { reserveRefund, getOrCreateRefundOperation, executeRefundOperation } = await import("@/lib/refund-operations");
const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("connection_limit", "1");
const a = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const b = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const vehicles: string[] = [], users: string[] = [];
afterEach(() => { vi.restoreAllMocks(); provider.refunds.create.mockReset(); provider.refunds.retrieve.mockReset(); provider.paymentIntents.create.mockReset(); provider.paymentIntents.retrieve.mockReset(); provider.paymentIntents.cancel.mockReset(); });
afterAll(async () => {
  await cleanupReservationsForVehicles(vehicles);
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await Promise.all([a.$disconnect(), b.$disconnect(), prisma.$disconnect()]);
});
async function fixture(paid = true, depositCents = 0) {
  const v = await createTestVehicle(), u = await createTestCustomer(); vehicles.push(v.id); users.push(u.id);
  const r = await createTestReservation({ vehicleId: v.id, customerId: u.id, pickupAt: new Date("2030-01-01"), returnAt: new Date("2030-01-03"), status: paid ? "CONFIRMED" : "AWAITING_PAYMENT", expiresAt: paid ? null : new Date(Date.now() + 60000), depositCents });
  if (depositCents) await prisma.securityDeposit.create({ data: { reservationId: r.id, amountCents: depositCents } });
  const p = await prisma.payment.create({ data: { reservationId: r.id, type: "RENTAL", status: paid ? "SUCCEEDED" : "REQUIRES_PAYMENT", amountCents: 15000, stripePaymentIntentId: `pi_${r.id}` } });
  return { r, p };
}
async function waitForDatabaseLock(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ wait_event_type: string | null }>>`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Second connection never blocked on the database lock");
}

describe("durable financial operations with real concurrent connections", () => {
  it("rotates an uncertain refund without freeing its reserved balance", async () => {
    const { r, p } = await fixture();
    const refund = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 15000, idempotencyKey: `rotation:${p.id}` });
    await prisma.refund.update({ where: { id: refund.id }, data: { updatedAt: new Date(0) } });
    // Scope the worker batch to this fixture; execution and projections use PostgreSQL.
    vi.spyOn(workerDb.refund, "findMany").mockResolvedValueOnce([{ ...refund, payment: p }] as never);
    provider.refunds.create.mockRejectedValueOnce(new Error("Provider outcome unknown"));
    expect(await recoverRefunds()).toEqual({ processed: 0, pending: 1 });
    const current = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(current.updatedAt.getTime()).toBeGreaterThan(0);
    expect(current.status).toBe("PENDING");
    await expect(getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: `rotation-overrun:${p.id}` })).rejects.toThrow("remaining refundable balance");
  });
  it("retrieves an existing pending refund after the replay window instead of recreating it", async () => {
    const { r, p } = await fixture();
    const refund = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 5000, idempotencyKey: `pending:${p.id}` });
    provider.refunds.create.mockResolvedValue({ id: `re_pending_${p.id}`, status: "pending" });
    await executeRefundOperation(refund.id, p.stripePaymentIntentId);
    await prisma.financialOperation.update({ where: { key: refund.idempotencyKey }, data: { firstAttemptAt: new Date(0) } });
    provider.refunds.retrieve.mockResolvedValue({ id: `re_pending_${p.id}`, status: "succeeded" });
    await executeRefundOperation(refund.id, p.stripePaymentIntentId);
    expect(provider.refunds.create).toHaveBeenCalledOnce(); expect(provider.refunds.retrieve).toHaveBeenCalledOnce();
  });

  it("holds the balance for an old uncertain outcome and never creates a second refund", async () => {
    const { r, p } = await fixture();
    const refund = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 15000, idempotencyKey: `unknown:${p.id}` });
    await prisma.financialOperation.update({ where: { key: refund.idempotencyKey }, data: { firstAttemptAt: new Date(0) } });
    provider.refunds.list.mockReturnValue([]);
    await expect(executeRefundOperation(refund.id, p.stripePaymentIntentId)).rejects.toThrow("unknown beyond safe replay window");
    expect(provider.refunds.create).not.toHaveBeenCalled();
    expect((await prisma.financialOperation.findUniqueOrThrow({ where: { key: refund.idempotencyKey } })).state).toBe("REVIEW");
    await expect(getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: `duplicate:${p.id}` })).rejects.toThrow("remaining refundable balance");
    await expect(getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 1, idempotencyKey: refund.idempotencyKey })).rejects.toThrow("different parameters");
  });
  it("does not revive a hold when another transaction takes the expired dates", async () => {
    const { r } = await fixture(false);
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "CHECKOUT_HOLD" } });
    const entered = barrier(), release = barrier();
    const winner = withReservationLock(r.id, async tx => {
      await tx.reservation.update({ where: { id: r.id }, data: { expiresAt: new Date(0) } });
      await tx.reservation.create({ data: { confirmationNumber: `winner_${r.id}`, customerId: r.customerId, vehicleId: r.vehicleId, pickupAt: r.pickupAt, returnAt: r.returnAt, rateType: "DAILY", rateAmountCents: 5000, units: 2, subtotalCents: 10000, totalCents: 10000, status: "CONFIRMED" } });
      entered.release(); await release.wait;
    }, a);
    await entered.wait;
    const [{ pid }] = await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const refresh = createOrRefreshHold({ customerId: r.customerId, vehicleId: r.vehicleId, pickupAt: r.pickupAt, returnAt: r.returnAt, extraIds: [] }, b);
    const rejected = expect(refresh).rejects.toThrow("no longer available");
    try { await waitForDatabaseLock(pid); } finally { release.release(); }
    await Promise.all([winner, rejected]);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("EXPIRED");
  });

  it("rechecks financial eligibility after waiting for a concurrent full-refund reservation", async () => {
    const { r, p } = await fixture();
    // Baseline financial gate really passes before the competing transaction.
    await withReservationLock(r.id, tx => assertFinancialTripStart(tx, r.id), b);
    const entered = barrier(), release = barrier();
    const refund = withReservationLock(r.id, async tx => {
      await reserveRefund(tx, { reservationId: r.id, paymentId: p.id, amountCents: p.amountCents, idempotencyKey: `trip-race:${p.id}` });
      entered.release(); await release.wait;
    }, a);
    await entered.wait;
    const [{ pid }] = await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const start = withReservationLock(r.id, tx => transitionReservation(tx, { id: r.id, from: "CONFIRMED", to: "ACTIVE", force: true }), b);
    const rejected = expect(start).rejects.toThrow("Financial state");
    try { await waitForDatabaseLock(pid); } finally { release.release(); }
    await Promise.all([refund, rejected]);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("CONFIRMED");
  });

  it("refund timeout wins while a deposit request is in flight and releases its eventual authorization", async () => {
    const { r, p } = await fixture(false, 30000);
    const entered = barrier(), release = barrier();
    let remote = { id: `pi_timeout_${r.id}`, status: "requires_capture", amount: 30000, amount_capturable: 30000, currency: "usd", created: Math.floor(Date.now()/1000), latest_charge: { id: "ch_test", created: Math.floor(Date.now()/1000), payment_method_details: { card: { capture_before: Math.floor(Date.now()/1000)+3600 } } } };
    provider.paymentIntents.create.mockImplementation(async () => { entered.release(); await release.wait; return remote; });
    provider.paymentIntents.retrieve.mockImplementation(async () => remote);
    provider.paymentIntents.cancel.mockImplementation(async () => { remote = { ...remote, status: "canceled" }; return remote; });
    provider.refunds.create.mockResolvedValue({ id: `re_timeout_${r.id}`, status: "succeeded" });
    const success = handlePaymentIntentSucceeded({ id: p.stripePaymentIntentId, status: "succeeded", payment_method: "pm_test", customer: "cus_test" } as never);
    await entered.wait;
    await expireStaleReservations(new Date(Date.now() + 31 * 60000));
    release.release(); await success;
    const saved = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id }, include: { deposit: true, refunds: true } });
    expect(saved.status).toBe("EXPIRED"); expect(saved.financialDisposition).toBe("REFUND_REQUIRED");
    expect(saved.deposit?.status).toBe("CANCELLED"); expect(saved.refunds).toHaveLength(1); expect(saved.refunds[0].status).toBe("SUCCEEDED");
  });
  it("does not downgrade capture when a failure handler resumes after success commits", async () => {
    const { r, p } = await fixture(false);
    const entered = barrier(), release = barrier();
    provider.paymentIntents.retrieve.mockImplementation(async () => { entered.release(); await release.wait; return { id: p.stripePaymentIntentId, status: "requires_payment_method" }; });
    const failed = handlePaymentIntentFailed({ id: p.stripePaymentIntentId } as never);
    await entered.wait;
    await handlePaymentIntentSucceeded({ id: p.stripePaymentIntentId, status: "succeeded" } as never);
    release.release(); await failed;
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCEEDED");
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("DOCUMENTS_REQUIRED");
  });

  it.each(["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST"] as const)("compensates a deposit authorization completing after %s", async cancellation => {
    const { r, p } = await fixture(false, 30000);
    const entered = barrier(), release = barrier();
    let remote = { id: `pi_deposit_${r.id}`, status: "requires_capture", amount: 30000, amount_capturable: 30000, currency: "usd", created: Math.floor(Date.now()/1000), latest_charge: { id: "ch_test", created: Math.floor(Date.now()/1000), payment_method_details: { card: { capture_before: Math.floor(Date.now()/1000)+3600 } } } };
    provider.paymentIntents.create.mockImplementation(async () => { entered.release(); await release.wait; return remote; });
    provider.paymentIntents.retrieve.mockImplementation(async () => remote);
    provider.paymentIntents.cancel.mockImplementation(async () => { remote = { ...remote, status: "canceled" }; return remote; });
    provider.refunds.create.mockResolvedValue({ id: `re_${r.id}`, status: "succeeded" });
    const success = handlePaymentIntentSucceeded({ id: p.stripePaymentIntentId, status: "succeeded", payment_method: "pm_test", customer: "cus_test" } as never);
    await entered.wait;
    // A distinct database connection commits cancellation while Stripe is in flight.
    await withReservationLock(r.id, tx => transitionReservation(tx, { id: r.id, from: "PAYMENT_FAILED", to: cancellation, force: true }), b);
    release.release(); await success;
    const saved = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id }, include: { deposit: true, refunds: true } });
    expect(saved.status).toBe(cancellation); expect(saved.deposit?.status).toBe("CANCELLED");
    expect(saved.refunds[0]?.status).toBe("SUCCEEDED"); expect(provider.paymentIntents.cancel).toHaveBeenCalledOnce();
  });
  it("serializes competing refund balances while both transactions are live", async () => {
    const { r, p } = await fixture();
    const entered = barrier(), release = barrier();
    const [{ pid: pidA }] = await a.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const [{ pid: pidB }] = await b.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    expect(pidA).not.toBe(pidB);
    const first = withReservationLock(r.id, async tx => {
      const refund = await reserveRefund(tx, { reservationId: r.id, paymentId: p.id, amountCents: 10000, idempotencyKey: `a:${p.id}` });
      entered.release(); await release.wait; return refund;
    }, a);
    await entered.wait;
    const second = withReservationLock(r.id, tx => reserveRefund(tx, { reservationId: r.id, paymentId: p.id, amountCents: 10000, idempotencyKey: `b:${p.id}` }), b);
    const rejected = expect(second).rejects.toThrow("remaining refundable balance");
    try { await waitForDatabaseLock(pidB); } finally { release.release(); }
    await Promise.all([first, rejected]);
    const total = await prisma.refund.aggregate({ where: { reservationId: r.id }, _sum: { amountCents: true } });
    expect(total._sum.amountCents).toBe(10000);
  });

  it("resumes a provider success when persisting its response crashes", async () => {
    const { r, p } = await fixture();
    const refund = await getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 5000, idempotencyKey: `crash:${p.id}` });
    const remote = new Map<string, { id: string; status: string }>();
    provider.refunds.create.mockImplementation(async (_payload, options) => {
      if (!remote.has(options.idempotencyKey)) remote.set(options.idempotencyKey, { id: `re_${p.id}`, status: "succeeded" });
      return remote.get(options.idempotencyKey);
    });
    const trigger = `test_refund_crash_${refund.id}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."id" = '${refund.id}' AND NEW."status" = 'SUCCEEDED' THEN RAISE EXCEPTION 'Injected crash after Stripe accepted'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      await expect(executeRefundOperation(refund.id, p.stripePaymentIntentId)).rejects.toThrow("DATABASE_OPERATION_FAILED");
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("PENDING");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "Refund"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    await executeRefundOperation(refund.id, p.stripePaymentIntentId);
    expect(provider.refunds.create).toHaveBeenCalledTimes(2);
    expect(remote.size).toBe(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("SUCCEEDED");
  });

  it("unit-checks the lease primitive independently of financial projections", async () => {
    const { r } = await fixture();
    const op = await withReservationLock(r.id, tx => prepareOperation(tx, { key: `lease:${r.id}`, kind: "TEST", reservationId: r.id, payload: { amount: 100 } }));
    const entered = barrier(), release = barrier();
    const old = runOperation(op, { create: async () => { entered.release(); await release.wait; return { id: "same-provider-operation" }; }, retrieve: async id => ({ id }), discover: async () => null });
    const oldRejected = expect(old).rejects.toThrow("lease lost");
    await entered.wait;
    await prisma.financialOperation.update({ where: { id: op.id }, data: { leaseExpiresAt: new Date(0) } });
    await runOperation(op, { create: async () => ({ id: "same-provider-operation" }), retrieve: async id => ({ id }), discover: async () => null });
    release.release(); await oldRejected;
    const saved = await prisma.financialOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(saved.state).toBe("OBSERVED"); expect(saved.providerId).toBe("same-provider-operation");
  });

  it("rejects stale event work before reserving refund balance", async () => {
    const { r, p } = await fixture();
    const event = await prisma.stripeEvent.create({ data: { stripeEventId: `evt_${r.id}`, type: "test", status: "PROCESSING", leaseToken: "new", processingStartedAt: new Date() } });
    await expect(eventFence.run({ id: event.id, token: "old" }, () => getOrCreateRefundOperation({ reservationId: r.id, paymentId: p.id, amountCents: 100, idempotencyKey: `stale:${p.id}` }))).rejects.toThrow("lease lost");
    expect(await prisma.refund.count({ where: { reservationId: r.id } })).toBe(0);
    await prisma.stripeEvent.delete({ where: { id: event.id } });
  });
});
