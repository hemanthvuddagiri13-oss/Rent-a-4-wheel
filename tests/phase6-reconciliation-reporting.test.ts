import { afterAll, afterEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileFinance } from "@/lib/payout-workers";
import * as ledger from "@/lib/finance-ledger";
import { workerResult, summarizeWorker } from "@/lib/worker-result";

afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

it("reports unresolved reconciliation work alongside caught accounting failures without changing the issue", async () => {
  const issue = await prisma.financeIssue.create({data:{key:"phase6-reporting-"+crypto.randomUUID(),kind:"ACCOUNTING_REVIEW",reason:"Synthetic unresolved evidence"}});
  vi.spyOn(prisma.financeIssue,"findMany").mockResolvedValue([issue]);
  vi.spyOn(ledger,"reconcileAccounting").mockResolvedValue({processed:1,worker:workerResult({attempted:2,checked:2,committed:1,failed:1,actionable:1})});
  try {
    const raw = await reconcileFinance();
    const result = summarizeWorker(raw);
    expect(result).toMatchObject({status:"PARTIAL_FAILURE",committed:1,failed:1,review:1+raw.imbalances,checked:3+raw.imbalances,actionable:2+raw.imbalances});
    const retained=await prisma.financeIssue.findUniqueOrThrow({where:{id:issue.id}});
    expect(retained.status).toBe(issue.status);
    expect(retained.checkedAt).not.toBeNull();
    expect(retained.resolution).toBeNull();
  } finally { await prisma.financeIssue.delete({where:{id:issue.id}}); }
});

it("does not call an all-review reconciliation pass NO_WORK", async () => {
  const issue=await prisma.financeIssue.create({data:{key:"phase6-review-"+crypto.randomUUID(),kind:"UNMATCHED_PROVIDER_OBJECT",reason:"Synthetic provider ownership not established",evidence:{providerId:"missing-synthetic-owner"}}});
  vi.spyOn(prisma.financeIssue,"findMany").mockResolvedValue([issue]);
  vi.spyOn(ledger,"reconcileAccounting").mockResolvedValue({processed:0,worker:workerResult()});
  try { const raw=await reconcileFinance(); expect(summarizeWorker(raw)).toMatchObject({status:"FAILED",committed:0,review:1+raw.imbalances,checked:1+raw.imbalances,actionable:1+raw.imbalances}); expect(raw.worker.children?.issues).toMatchObject({checked:1,review:1,committed:0}); }
  finally { await prisma.financeIssue.delete({where:{id:issue.id}}); }
});
