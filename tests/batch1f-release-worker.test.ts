import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, createTestCustomer, createTestReservation, createTestVehicle, cleanupReservationsForVehicles } from "./helpers/factories";
import { recoverDeposits, dueOperations } from "@/lib/financial-workers";
import { executeDepositReleaseOperation } from "@/lib/deposit-authorization";
import { barrier } from "./helpers/barrier";
const provider = vi.hoisted(() => ({ paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ stripe: provider }));
const vehicles: string[] = [], users: string[] = [], caseIds: string[] = [];
afterEach(() => { provider.paymentIntents.retrieve.mockReset(); provider.paymentIntents.cancel.mockReset(); });
afterAll(async () => { await prisma.auditLog.deleteMany({ where: { entityId: { in: caseIds } } }); await cleanupReservationsForVehicles(vehicles); await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.$disconnect(); });
describe("ownership-blocked release recovery", () => {
  async function fixture() {
    const v = await createTestVehicle(), u = await createTestCustomer(); vehicles.push(v.id); users.push(u.id);
    const r = await createTestReservation({ vehicleId: v.id, customerId: u.id, pickupAt: new Date("2039-01-01"), returnAt: new Date("2039-01-03"), status: "CANCELLED_BY_CUSTOMER", depositCents: 15000 });
    const intentId = "pi_release_" + randomUUID();
    const original = await prisma.financialOperation.create({ data: { key: randomUUID(), kind: "DEPOSIT", reservationId: r.id, providerId: intentId, fingerprint: "fixture", payload: {}, state: "OBSERVED", generation: 1 } });
    await prisma.securityDeposit.create({ data: { reservationId: r.id, amountCents: 15000, operationId: original.id, stripePaymentIntentId: intentId, generation: 1 } });
    const release = await prisma.financialOperation.create({ data: { key: "deposit-release:" + intentId, kind: "DEPOSIT_RELEASE", reservationId: r.id, fingerprint: "fixture", payload: { intentId }, priority: 0, generation: 1 } });
    return { r, release, intentId };
  }
  it("quarantines 25 blocked releases, reports counts and executes the later valid release within two runs", async () => {
    const v = await createTestVehicle(), u = await createTestCustomer(); vehicles.push(v.id); users.push(u.id);
    const r = await createTestReservation({ vehicleId: v.id, customerId: u.id, pickupAt: new Date("2039-01-01"), returnAt: new Date("2039-01-03"), status: "CANCELLED_BY_CUSTOMER", depositCents: 15000 });
    const validId = "pi_valid_" + randomUUID();
    const originals = [];
    for (let i = 0; i < 26; i++) originals.push(await prisma.financialOperation.create({ data: { key: randomUUID(), kind: "DEPOSIT", reservationId: r.id, fingerprint: "fixture", payload: { amount: 15000, currency: "usd" }, providerId: i === 25 ? validId : "pi_blocked_" + randomUUID(), generation: i + 1, state: "OBSERVED" } }));
    await prisma.securityDeposit.create({ data: { reservationId: r.id, amountCents: 15000, operationId: originals[25].id, stripePaymentIntentId: validId, generation: 26 } });
    await prisma.providerObjectOwnership.updateMany({ where: { providerId: { in: originals.slice(0, 25).map(o => o.providerId!) } }, data: { kind: "BLOCKED" } });
    const releases = [];
    for (let i = 0; i < originals.length; i++) releases.push(await prisma.financialOperation.create({ data: { key: "deposit-release:" + originals[i].providerId, kind: "DEPOSIT_RELEASE", reservationId: r.id, fingerprint: "fixture", payload: { intentId: originals[i].providerId }, generation: i + 1, priority: 0, createdAt: new Date(i), state: "READY" } }));
    provider.paymentIntents.retrieve.mockResolvedValue({ id: validId, status: "requires_capture" });
    provider.paymentIntents.cancel.mockResolvedValue({ id: validId, status: "canceled", amount_capturable: 0 });
    const first = await recoverDeposits();
    expect(first.releases).toEqual({ processed: 0, failed: 0, quarantined: 25, uncertain: 0 });
    expect(first.quarantined).toBe(25); expect(first.processed).toBe(first.deposits.processed);
    expect(first.pending).toBe(first.deposits.pending); expect(first.failed).toBe(first.deposits.pending);
    expect(provider.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
    const cases = await prisma.financialCase.findMany({ where: { reservationId: r.id } }); caseIds.push(...cases.map(c => c.id));
    expect(cases).toHaveLength(25);
    expect(await prisma.auditLog.count({ where: { entityId: { in: caseIds }, action: "financial-case.release-ownership-quarantined" } })).toBe(25);
    for (let i = 0; i < 25; i++) {
      const op = await prisma.financialOperation.findUniqueOrThrow({ where: { id: releases[i].id } });
      expect(op).toMatchObject({ state: "REVIEW", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null });
      expect(cases.find(c => c.operationId === op.id)).toMatchObject({ providerId: originals[i].providerId, evidence: expect.objectContaining({ generation: i + 1, ownership: expect.objectContaining({ kind: "BLOCKED" }) }) });
    }
    expect((await dueOperations("DEPOSIT_RELEASE")).filter(o => o.reservationId === r.id).map(o => o.id)).toEqual([releases[25].id]);
    expect((await recoverDeposits()).releases).toEqual({ processed: 1, failed: 0, quarantined: 0, uncertain: 0 });
    expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(1); expect(provider.paymentIntents.cancel).toHaveBeenCalledWith(validId, {}, { idempotencyKey: releases[25].key });
    expect((await recoverDeposits()).releases).toEqual({ processed: 0, failed: 0, quarantined: 0, uncertain: 0 });
    await executeDepositReleaseOperation(releases[0]);
    expect(await prisma.financialCase.count({ where: { reservationId: r.id } })).toBe(25);
    expect(await prisma.auditLog.count({ where: { entityId: { in: caseIds }, action: "financial-case.release-ownership-quarantined" } })).toBe(25);
  });
  it.each(["RENTAL", "missing"])("quarantines %s ownership without provider calls", async kind => {
    const { r, release, intentId } = await fixture();
    if (kind === "missing") await prisma.providerObjectOwnership.delete({ where: { providerId: intentId } });
    else await prisma.providerObjectOwnership.update({ where: { providerId: intentId }, data: { kind } });
    expect(await executeDepositReleaseOperation(release)).toMatchObject({ status: "quarantined" });
    expect(provider.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
    const c = await prisma.financialCase.findFirstOrThrow({ where: { reservationId: r.id } }); caseIds.push(c.id);
    expect(c.operationId).toBe(release.id);
  });
  it("revokes an active release lease if ownership becomes blocked during retrieval", async () => {
    const { r, release, intentId } = await fixture(), entered = barrier(), resume = barrier();
    provider.paymentIntents.retrieve.mockImplementation(async () => { entered.release(); await resume.wait; return { id: intentId, status: "requires_capture" }; });
    const running = executeDepositReleaseOperation(release); await entered.wait;
    expect((await prisma.financialOperation.findUniqueOrThrow({ where: { id: release.id } })).leaseToken).not.toBeNull();
    await prisma.providerObjectOwnership.update({ where: { providerId: intentId }, data: { kind: "BLOCKED" } });
    resume.release(); expect(await running).toMatchObject({ status: "quarantined" });
    expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(await prisma.financialOperation.findUniqueOrThrow({ where: { id: release.id } })).toMatchObject({ state: "REVIEW", leaseToken: null, leaseExpiresAt: null });
    caseIds.push((await prisma.financialCase.findFirstOrThrow({ where: { reservationId: r.id } })).id);
  });
  it("reports provider failure as failed/pending rather than processed or quarantined", async () => {
    const { release } = await fixture(); provider.paymentIntents.retrieve.mockRejectedValue(new Error("Provider unavailable"));
    const result = await recoverDeposits(); expect(result.releases).toEqual({ processed: 0, failed: 1, quarantined: 0, uncertain: 0 });
    expect(result.pending).toBe(result.deposits.pending + 1); expect(result.failed).toBe(result.deposits.pending + 1); expect(result.processed).toBe(result.deposits.processed);
    expect((await prisma.financialOperation.findUniqueOrThrow({ where: { id: release.id } })).state).toBe("RETRY");
  });
});
