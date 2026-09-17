import { afterAll, afterEach, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma, createTestHost, createTestCustomer, createTestVehicle, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { tripCommand } from "@/lib/trip-experience";
import { reconcileRefundStatus } from "@/lib/refund-operations";
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
import { executeDepositReleaseOperation } from "@/lib/deposit-authorization";
import { prepareOperation } from "@/lib/financial-operations";
import { withReservationLock } from "@/lib/financial-locks";
import { transitionReservation } from "@/lib/reservation-state-machine";
const provider = vi.hoisted(() => ({ refunds: { retrieve: vi.fn() }, paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ stripe: provider }));
const users: string[] = [], hosts: string[] = [], vehicles: string[] = [];
const separate = new PrismaClient();
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await cleanupReservationsForVehicles(vehicles);
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } });
  await prisma.hostProfile.deleteMany({ where: { id: { in: hosts } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await separate.$disconnect(); await prisma.$disconnect();
});
async function fixture() {
  const h = await createTestHost(), customer = await createTestCustomer(), admin = await createTestCustomer({ role: "SUPER_ADMIN" });
  users.push(h.user.id, customer.id, admin.id); hosts.push(h.hostProfile.id);
  const v = await createTestVehicle({ hostId: h.hostProfile.id }); vehicles.push(v.id);
  const r = await createTestReservation({ vehicleId: v.id, customerId: customer.id, pickupAt: new Date(Date.now() - 86400000), returnAt: new Date(), status: "RETURN_IN_PROGRESS", depositCents: 10000 });
  await prisma.trip.create({ data: { reservationId: r.id, startedAt: new Date(Date.now() - 86400000), startMileage: 1000 } });
  const paymentId = "pi_rental_" + randomUUID(), intentId = "pi_deposit_" + randomUUID(), refundId = "re_external_" + randomUUID();
  await prisma.payment.create({ data: { reservationId: r.id, type: "RENTAL", status: "SUCCEEDED", amountCents: r.totalCents, stripePaymentIntentId: paymentId } });
  const deposit = await withReservationLock(r.id, tx => prepareOperation(tx, { key: "deposit:" + r.id, kind: "DEPOSIT", reservationId: r.id, payload: { amount: 10000, currency: "usd" } }));
  await prisma.financialOperation.update({ where: { id: deposit.id }, data: { state: "OBSERVED", providerId: intentId, generation: 1, result: { id: intentId, status: "requires_capture" } } });
  await prisma.securityDeposit.create({ data: { reservationId: r.id, amountCents: 10000, stripePaymentIntentId: intentId, operationId: deposit.id, generation: 1, status: "SUCCEEDED", stripeStatus: "requires_capture", capturableAmountCents: 10000, authorizationExpiresAt: new Date(Date.now() + 86400000) } });
  for (const [submittedById, submittedByRole] of [[customer.id, "CUSTOMER"], [h.user.id, "HOST"]] as const) await prisma.conditionReport.create({ data: { reservationId: r.id, phase: "POST_TRIP", submittedById, submittedByRole, acceptedAt: new Date(), mileage: 1100, fuelLevel: 90, photos: { create: [{ category: "EXTERIOR", storageKey: "local:test" }, { category: "INTERIOR", storageKey: "local:test" }] } } });
  const observed = { id: refundId, status: "pending", amount: 1000, currency: "usd", payment_intent: paymentId, metadata: {} };
  provider.refunds.retrieve.mockResolvedValue(observed);
  return { ...h, r, v, admin, deposit, observed, importRefund: () => reconcileRefundStatus(refundId, "pending") };
}
async function unchanged(id: string) {
  expect(await prisma.reservation.findUnique({ where: { id } })).toMatchObject({ status: "RETURN_IN_PROGRESS", financialDisposition: "REVIEW" });
  expect(await prisma.trip.findUnique({ where: { reservationId: id } })).toMatchObject({ endedAt: null });
  expect(await prisma.financialCase.count({ where: { reservationId: id, status: { not: "RESOLVED" } } })).toBe(1);
  expect(await prisma.financialOperation.count({ where: { reservationId: id, kind: "DEPOSIT_RELEASE" } })).toBe(0);
  expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
}
it("real external-refund reconciliation blocks ordinary and forced completion without releasing deposits", async () => {
  const f = await fixture(); await f.importRefund();
  await expect(tripCommand(f.user.id, f.r.id, "complete")).rejects.toThrow("settlement authority");
  await expect(withReservationLock(f.r.id, tx => transitionReservation(tx, { id: f.r.id, from: "RETURN_IN_PROGRESS", to: "COMPLETED", force: true, data: { financialDisposition: "TERMINATED" } }))).rejects.toThrow("settlement authority");
  await unchanged(f.r.id);
});
it("only verified super-admin case resolution permits completion and its disposition is preserved", async () => {
  const f = await fixture(); await f.importRefund();
  const c = await prisma.financialCase.findFirstOrThrow({ where: { reservationId: f.r.id } });
  const input = { caseId: c.id, action: "AUTHORIZE_SETTLEMENT" as const, reason: "Reviewed provider evidence for no-charge return completion" };
  await expect(resolveFinancialCase(f.admin, input)).rejects.toThrow("Verify provider evidence");
  provider.refunds.retrieve.mockResolvedValue({ ...f.observed, status: "failed" });
  await resolveFinancialCase(f.admin, { ...input, action: "CONFIRM_FAILURE" });
  await expect(tripCommand(f.user.id, f.r.id, "complete")).rejects.toThrow("settlement authority");
  await expect(resolveFinancialCase(f.user, input)).rejects.toThrow("Forbidden");
  await resolveFinancialCase(f.admin, input);
  expect(await prisma.reservation.findUnique({ where: { id: f.r.id } })).toMatchObject({ status: "RETURN_IN_PROGRESS", financialDisposition: "TERMINATED" });
  expect(await prisma.financialOperation.count({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } })).toBe(0);
  await tripCommand(f.user.id, f.r.id, "complete");
  expect(await prisma.reservation.findUnique({ where: { id: f.r.id } })).toMatchObject({ status: "COMPLETED", financialDisposition: "TERMINATED" });
  expect(await prisma.financialCase.findUnique({ where: { id: c.id } })).toMatchObject({ status: "RESOLVED", resolution: "AUTHORIZE_SETTLEMENT" });
  expect(await prisma.financialOperation.count({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } })).toBe(1);
  expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
});
async function waitForBlocked(count: number) {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;
    if (new Set(rows.map(r => r.pid)).size >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Independent service connections did not block at the PostgreSQL barrier");
}
it.each(["reconciliation", "completion"])("serializes %s first against the competing service on separate connections", async first => {
  const f = await fixture(), entered = barrier(), release = barrier();
  const holder = separate.$transaction(async tx => { await tx.$queryRaw`SELECT financial_guard_xact(${'vehicle:' + f.v.id})`; entered.release(); await release.wait; }, { timeout: 15000 });
  await entered.wait;
  const completion = () => tripCommand(f.user.id, f.r.id, "complete");
  const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
  try {
    pending.push(Promise.allSettled([first === "reconciliation" ? f.importRefund() : completion()]));
    await waitForBlocked(1);
    pending.push(Promise.allSettled([first === "reconciliation" ? completion() : f.importRefund()]));
    await waitForBlocked(2);
  } finally { release.release(); await holder; }
  const outcomes = (await Promise.all(pending)).flat();
  if (first === "reconciliation") {
    expect(outcomes.map(o => o.status)).toEqual(["fulfilled", "rejected"]);
    await unchanged(f.r.id);
  } else {
    expect(outcomes.map(o => o.status)).toEqual(["fulfilled", "fulfilled"]);
    const op = await prisma.financialOperation.findFirstOrThrow({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } });
    expect(await prisma.reservation.findUnique({ where: { id: f.r.id } })).toMatchObject({ status: "COMPLETED", financialDisposition: "REVIEW" });
    // Completion committed before the review. Its queued release must now stop
    // even before provider retrieval, and cannot cancel with stale authority.
    expect(await executeDepositReleaseOperation(op)).toMatchObject({ status: "quarantined" });
    expect(provider.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(await prisma.financialOperation.count({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } })).toBe(1);
  }
  expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
});
it.each(["REVIEW", "RETRY", "RUNNING", "READY", "DEAD_LETTER"])("blocks an uncertain %s operation even without a case flag", async state => {
  const f = await fixture(); await prisma.financialOperation.update({ where: { id: f.deposit.id }, data: { state } });
  await expect(tripCommand(f.user.id, f.r.id, "complete")).rejects.toThrow("settlement authority");
  expect(await prisma.financialOperation.count({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } })).toBe(0);
  expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
});

it("rechecks review after provider retrieval before a queued release can dispatch", async () => {
  const f = await fixture(); await tripCommand(f.user.id, f.r.id, "complete");
  const op = await prisma.financialOperation.findFirstOrThrow({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } });
  const entered = barrier(), resume = barrier();
  provider.paymentIntents.retrieve.mockImplementationOnce(async () => { entered.release(); await resume.wait; return { id: (op.payload as { intentId: string }).intentId, status: "requires_capture" }; });
  const running = executeDepositReleaseOperation(op); await entered.wait;
  try { await f.importRefund(); } finally { resume.release(); }
  await running;
  expect(await prisma.reservation.findUnique({ where: { id: f.r.id } })).toMatchObject({ financialDisposition: "REVIEW" });
  expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
});

it.each(["case", "reconciliation", "REFUND_REQUIRED"])("does not use a stale OPEN decision when %s blocks settlement", async kind => {
  const f = await fixture();
  if (kind === "case") await prisma.financialCase.create({ data: { reservationId: f.r.id, customerId: f.r.customerId, sourceKey: randomUUID(), kind: "REFUND", reason: "Unresolved evidence" } });
  else if (kind === "reconciliation") await prisma.paymentReconciliation.create({ data: { reservationId: f.r.id, reason: "WEBHOOK_PROCESSING_REPEATEDLY_FAILED", status: "NEEDS_MANUAL_REVIEW" } });
  else await prisma.reservation.update({ where: { id: f.r.id }, data: { financialDisposition: kind } });
  await expect(tripCommand(f.user.id, f.r.id, "complete")).rejects.toThrow("settlement authority");
  expect(await prisma.financialOperation.count({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } })).toBe(0);
});

it("staff cancellation cannot overwrite a pre-trip financial review or plan a release", async () => {
  const f = await fixture(); await f.importRefund();
  await prisma.trip.delete({ where: { reservationId: f.r.id } });
  await prisma.reservation.update({ where: { id: f.r.id }, data: { status: "CONFIRMED" } });
  await expect(withReservationLock(f.r.id, tx => transitionReservation(tx, { id: f.r.id, from: "CONFIRMED", to: "CANCELLED_BY_HOST", force: true }))).rejects.toThrow("settlement authority");
  expect(await prisma.reservation.findUnique({ where: { id: f.r.id } })).toMatchObject({ status: "CONFIRMED", financialDisposition: "REVIEW" });
  expect(await prisma.financialOperation.count({ where: { reservationId: f.r.id, kind: "DEPOSIT_RELEASE" } })).toBe(0);
});
