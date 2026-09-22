import type Stripe from "stripe";
import * as provider from "@/lib/finance-provider";
import {createTestCustomer,createTestVehicle,createTestReservation} from "./helpers/factories";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileFinance, auditFinanceHistory } from "@/lib/payout-workers";
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

it("retains successful historical checks when another provider lookup fails, without changing payment authority",async()=>{
 const user=await createTestCustomer(),vehicle=await createTestVehicle();
 const reservation=await createTestReservation({vehicleId:vehicle.id,customerId:user.id,pickupAt:new Date("2046-01-01"),returnAt:new Date("2046-01-04"),status:"COMPLETED"});
 const first=await prisma.payment.create({data:{reservationId:reservation.id,type:"RENTAL",status:"SUCCEEDED",amountCents:1000,stripePaymentIntentId:"pi_failed_"+reservation.id}});
 const second=await prisma.payment.create({data:{reservationId:reservation.id,type:"ADDITIONAL_CHARGE",status:"SUCCEEDED",amountCents:1000,stripePaymentIntentId:"pi_ok_"+reservation.id}});
 const row=await prisma.reservation.findUniqueOrThrow({where:{id:reservation.id},include:{payments:true,refunds:true}});
 vi.spyOn(prisma.reservation,"findMany").mockResolvedValue([row]);
 vi.spyOn(prisma.financialOperation,"findMany").mockResolvedValue([]);
 const retrieve=vi.fn(async(id:string)=>{if(id===first.stripePaymentIntentId)throw new Error("Controlled provider outage");return {id,amount:1000,currency:"usd",status:"succeeded",latest_charge:null};});
 vi.spyOn(provider,"financeStripe").mockReturnValue({paymentIntents:{retrieve}} as unknown as Stripe);
 try {
  const result=await auditFinanceHistory();expect(result.worker).toMatchObject({status:"PARTIAL_FAILURE",checked:2,committed:1,failed:1,actionable:1});
  expect(retrieve).toHaveBeenCalledTimes(2);
  expect(await prisma.payment.findUnique({where:{id:first.id}})).toMatchObject({status:"SUCCEEDED",amountCents:1000});
  expect(await prisma.payment.findUnique({where:{id:second.id}})).toMatchObject({status:"SUCCEEDED",amountCents:1000});
  expect(await prisma.reservation.findUnique({where:{id:reservation.id}})).toMatchObject({financialDisposition:reservation.financialDisposition});
 }finally{await prisma.vehicle.update({where:{id:vehicle.id},data:{status:"INACTIVE"}});}
});
