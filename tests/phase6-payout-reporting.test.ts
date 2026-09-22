import { afterAll, afterEach, expect, it, vi } from "vitest";
import { prisma, createTestHost } from "./helpers/factories";
import { schedulePayouts, payoutWorkers } from "@/lib/payout-workers";
import { summarizeWorker, workerResult } from "@/lib/worker-result";
import { POST } from "@/app/api/cron/payouts/[worker]/route";
import { dispatchCron } from "../scripts/dispatch-cron.mjs";

const hosts: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await prisma.connectAccount.updateMany({ where: { hostId: { in: hosts } }, data: { active: false } });
  hosts.length = 0;
});
afterAll(() => prisma.$disconnect());

async function schedule(mode: "success" | "review" | "failure") {
  const { user, hostProfile } = await createTestHost(); hosts.push(hostProfile.id);
  await prisma.financeRule.create({ data: {
    kind: "PAYOUT", scope: "HOST", scopeId: hostProfile.id, version: 1,
    config: { delayDays: 1, minimumCents: 100, allowedSchedules: mode === "review" ? ["MANUAL"] : ["WEEKLY"], timezone: "America/Chicago" },
    effectiveAt: new Date(0), approvedAt: new Date(), createdById: user.id,
  } });
  return prisma.connectAccount.create({ data: { hostId: hostProfile.id, schedule: "WEEKLY", minimumCents: 250,
    timezone: mode === "failure" ? "Invalid/Zone" : "America/Chicago", nextRunAt: new Date(0) } });
}

it("reports a committed scheduling intent, retains its identity and amount, and does not dispatch money", async () => {
  const account = await schedule("success");
  const operations = await prisma.financialOperation.count();
  expect(summarizeWorker(await schedulePayouts())).toMatchObject({ status: "SUCCESS", committed: 1, failed: 0 });
  const key = `finance-schedule:${account.hostId}:${account.nextRunAt.toISOString()}`;
  expect(await prisma.outboxMessage.count({ where: { deliveryKey: key, type: "finance_schedule" } })).toBe(1);
  expect((await prisma.connectAccount.findUniqueOrThrow({ where: { hostId: account.hostId } })).minimumCents).toBe(250);
  expect(summarizeWorker(await schedulePayouts())).toMatchObject({ status: "NO_WORK", committed: 0 });
  expect(await prisma.financialOperation.count()).toBe(operations);
});

it.each(["review", "failure"] as const)("reports an all-%s batch as actionable, preserving deferred money movement", async mode => {
  const account = await schedule(mode);
  const result = summarizeWorker(await schedulePayouts());
  expect(result).toMatchObject({ status: "FAILED", committed: 0, actionable: 1 });
  expect(mode === "review" ? result.review : result.failed).toBe(1);
  expect(await prisma.financeIssue.count({ where: { key: "schedule:" + account.hostId, kind: "SCHEDULE_REVIEW" } })).toBe(1);
  expect(await prisma.outboxMessage.count({ where: { deliveryKey: `finance-schedule:${account.hostId}:${account.nextRunAt.toISOString()}` } })).toBe(0);
});

it("keeps committed work visible beside a caught scheduling failure", async () => {
  await schedule("success"); await schedule("failure");
  expect(summarizeWorker(await schedulePayouts())).toMatchObject({ status: "PARTIAL_FAILURE", committed: 1, failed: 1, actionable: 1 });
});

it("preserves checked and actionable historical counters through the shared result contract", () => {
  const result = workerResult({}, { payments: workerResult({ checked: 3, attempted: 3, committed: 2, review: 1, actionable: 1 }), payouts: workerResult({ checked: 2, attempted: 2, committed: 2 }) });
  expect(summarizeWorker({ worker: result })).toMatchObject({ checked: 5, actionable: 1, committed: 4, status: "PARTIAL_FAILURE" });
});

it.each(["SUCCESS", "PARTIAL_FAILURE", "FAILED", "NO_WORK"] as const)("authenticated payout cron and dispatcher expose %s", async status => {
  vi.stubEnv("CRON_SECRET", "x".repeat(40));
  const worker = workerResult(status === "SUCCESS" ? { committed: 1 } : status === "PARTIAL_FAILURE" ? { committed: 1, failed: 1 } : status === "FAILED" ? { review: 1 } : {});
  vi.spyOn(payoutWorkers, "schedule").mockResolvedValue({ planned: worker.committed, worker });
  expect((await POST(new Request("https://fixture.invalid/api/cron/payouts/schedule"), { params: Promise.resolve({ worker: "schedule" }) })).status).toBe(401);
  const invoke = () => POST(new Request("https://fixture.invalid/api/cron/payouts/schedule", { method: "POST", headers: { authorization: "Bearer " + "x".repeat(40) } }), { params: Promise.resolve({ worker: "schedule" }) });
  const response = await invoke();
  expect((await response.json()).worker.status).toBe(status);
  const request: typeof fetch = async () => invoke();
  const dispatched = dispatchCron("payouts/schedule", { NODE_ENV: "test", SITE_URL: "https://fixture.invalid", CRON_SECRET: "x".repeat(40) }, request);
  if (status === "FAILED" || status === "PARTIAL_FAILURE") await expect(dispatched).rejects.toThrow("CRON_HTTP_503");
  else await expect(dispatched).resolves.toMatchObject({ status: 200 });
});
