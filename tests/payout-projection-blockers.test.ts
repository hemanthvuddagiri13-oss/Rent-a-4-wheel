import { afterAll,afterEach,beforeEach,describe,it,expect,vi } from "vitest";
import type { FinancialOperation } from "@prisma/client";
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma,one,two,fixture,cleanup,users } from "./helpers/payout-blocker-fixture";
import { createTestCustomer } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { runOperation,prepareOperation } from "@/lib/financial-operations";
import { createPayoutBatch,planBankPayout,applyFinanceObject,planTransferReversal,voidUndispatchedBatch,retryBankPayout } from "@/lib/payout-operations";
import { withReservationLock } from "@/lib/financial-locks";
import { lockFinanceOperation,lockPayoutReservations,payoutEligibility } from "@/lib/payout-authority";
import { accountReservation,journal } from "@/lib/finance-ledger";
import { accountingCompleteness } from "@/lib/finance-completeness";
import { handleFinanceEvent } from "@/lib/finance-webhooks";
import { allocateChargeback } from "@/lib/finance-admin";
import { bankMovement } from "@/lib/payout-movement";
import { reconcileRefundStatus } from "@/lib/refund-operations";
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
import type { FinanceProviderObject } from "@/lib/finance-provider";

const external=vi.hoisted(()=>({retrieve:vi.fn(),bank:vi.fn(),dispute:vi.fn(),charge:vi.fn()}));
vi.mock("@/lib/stripe",()=>({stripe:{refunds:{retrieve:external.retrieve}}}));
vi.mock("stripe",()=>({default:class{
 accounts={retrieve:async(id:string)=>{const a=await prisma.connectAccount.findUniqueOrThrow({where:{accountId:id}});return{id,metadata:{hostId:a.hostId},payouts_enabled:true,details_submitted:true,requirements:{},settings:{payouts:{schedule:{interval:"manual"}}}};}};
 payouts={retrieve:external.bank};
 disputes={retrieve:external.dispute};
 charges={retrieve:external.charge};
 balance={retrieve:async()=>({available:[{currency:"usd",amount:100000000}]})};
}}));
beforeEach(()=>{vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();external.retrieve.mockReset();});
afterAll(cleanup);

function provider(){
 const ledger=new Map<string,FinanceProviderObject>();
 const create=vi.fn(async(op:FinancialOperation)=>{const p=op.payload as {hostId:string;accountId:string;amount:number;currency:string};const r:FinanceProviderObject={id:(op.kind==="FINANCE_TRANSFER"?"tr_":op.kind==="FINANCE_REVERSAL"?"trr_":"po_")+randomUUID(),operationKey:op.key,kind:op.kind,...p,status:op.kind==="FINANCE_PAYOUT"?"paid":op.kind==="FINANCE_REVERSAL"?"reversed":"transferred",amountReversed:0};ledger.set(op.key,r);return r;});
 const retrieve=vi.fn(async(op:FinancialOperation)=>{const r=ledger.get(op.key);if(!r)throw Error("Provider cannot classify outcome");return r;});
 const execute=(op:FinancialOperation,crash=false)=>runOperation(op,{create:()=>create(op),retrieve:()=>retrieve(op),discover:async()=>ledger.get(op.key)??null,apply:async(tx,result)=>{await applyFinanceObject(tx,op,result);if(crash)await tx.$executeRawUnsafe("SELECT 1 / 0");}});
 return {ledger,create,retrieve,execute};
}
async function setup(){const f=await fixture(undefined,"pi_"+randomUUID()),b=await createPayoutBatch(f.h.hostProfile.id),transfer=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+b.id}});return {...f,batchId:b.id!,transfer};}
async function admin(){const a=await createTestCustomer({role:"SUPER_ADMIN"});users.push(a.id);return a;}
async function code(a:Awaited<ReturnType<typeof admin>>){await prisma.authCode.deleteMany({where:{email:a.email}});await prisma.authCode.create({data:{email:a.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});return "123456";}
async function externalRefund(f:Awaited<ReturnType<typeof setup>>,amount=5000){const refund={id:"re_"+randomUUID(),amount,currency:"usd",payment_intent:f.payment.stripePaymentIntentId,status:"succeeded",metadata:{}} as Stripe.Refund;external.retrieve.mockResolvedValue(refund);await reconcileRefundStatus(refund.id,"succeeded");return prisma.refund.findUniqueOrThrow({where:{stripeRefundId:refund.id}});}
async function settlement(a:Awaited<ReturnType<typeof admin>>,f:Awaited<ReturnType<typeof setup>>){const c=await prisma.financialCase.findFirstOrThrow({where:{reservationId:f.r.id,kind:"REFUND",status:{not:"RESOLVED"}}});await resolveFinancialCase(a,{caseId:c.id,action:"ADOPT",reason:"Verify externally observed refund"});return {caseId:c.id,action:"AUTHORIZE_SETTLEMENT" as const,reason:"Approve reviewed post-trip refund settlement"};}
async function recoveryIssue(f:Awaited<ReturnType<typeof setup>>,a:Awaited<ReturnType<typeof admin>>){
 const id='dp_'+randomUUID(),charge='ch_'+randomUUID();external.dispute.mockResolvedValue({id,charge,currency:'usd',amount:4500,status:'lost'});external.charge.mockResolvedValue({id:charge,payment_intent:f.payment.stripePaymentIntentId});
 await handleFinanceEvent({id:'evt_'+randomUUID(),type:'charge.dispute.closed',data:{object:{id}}} as Stripe.Event);
 const allocation=await prisma.financeIssue.findUniqueOrThrow({where:{key:'chargeback-allocation:'+id}});await allocateChargeback(a.id,allocation.id,await code(a));
 return prisma.financeIssue.findFirstOrThrow({where:{reservationId:f.r.id,kind:'POST_PAYOUT_LOSS'}});
}
async function memo(hostId:string){const rows=await prisma.$queryRaw<Array<{balance:bigint}>>`SELECT COALESCE(sum(l."debitCents"-l."creditCents"),0)::bigint balance FROM "LedgerLine" l JOIN "LedgerJournal" j ON j.id=l."journalId" WHERE j."hostId"=${hostId} AND l.account='MEMO_CONNECT_FUNDS'`;return Number(rows[0].balance);}
async function blockedSessions(minimum=1){let ids:number[]=[];for(let n=0;n<400;n++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard%'`;ids=[...new Set(rows.map(r=>r.pid))];if(ids.length>=minimum)break;await new Promise(r=>setTimeout(r,10));}expect(ids.length).toBeGreaterThanOrEqual(minimum);return ids;}

describe("refund accounting completeness",()=>{
 it("blocks a fully transferred bank-ready batch on unprojected external refund accounting",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const bank=await planBankPayout(f.batchId);
  await externalRefund(f);const decision=await settlement(a,f);await expect(resolveFinancialCase(a,decision)).rejects.toThrow("Accounting incomplete");
  // Transfer is already confirmed and the immutable bank amount is otherwise
  // payable, so this exercises accounting authority rather than a missing transfer.
  await expect(remote.execute(bank)).rejects.toThrow("Accounting incomplete");
  expect(remote.create).toHaveBeenCalledTimes(1);expect(remote.create.mock.calls.filter(([o])=>o.kind==="FINANCE_PAYOUT")).toHaveLength(0);
  expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({refundedCents:0});
  expect(await prisma.ledgerJournal.count({where:{hostId:f.h.hostProfile.id,kind:"HOST_PAYOUT"}})).toBe(0);
  expect(await prisma.financeIssue.findFirst({where:{reservationId:f.r.id,kind:"ACCOUNTING_INCOMPLETE"}})).not.toBeNull();
 });
 it("does not certify matching summaries and journals that violate the frozen refund allocation",async()=>{
  const f=await setup(),refund=await externalRefund(f);
  await withReservationLock(f.r.id,async tx=>{
   await journal(tx,{key:"refund:"+refund.id,kind:"REFUND",currency:"usd",reservationId:f.r.id,hostId:f.h.hostProfile.id,providerId:refund.stripeRefundId,description:"Simulated historical under-allocation",lines:[{account:"HOST_PAYABLE",debitCents:2000},{account:"PLATFORM_REFUND_COST",debitCents:3000},{account:"STRIPE_CLEARING",creditCents:5000}]});
   await tx.hostEarning.update({where:{reservationId:f.r.id},data:{refundedCents:2000}});
   await accountReservation(tx,f.r.id);
  });
  const result=await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id));expect(result.complete).toBe(false);expect(result.reasons.join("; ")).toContain("frozen policy entitlement");
  const remote=provider();await expect(remote.execute(f.transfer)).rejects.toThrow();expect(remote.create).toHaveBeenCalledTimes(0);
 });
 it("real external reconciliation cannot release the case or dispatch 13500 before accounting; void/rebuild dispatches 9000 once",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await externalRefund(f);const decision=await settlement(a,f);
  // Crucial reproduction: no call to accounting occurs before these attempts.
  await expect(resolveFinancialCase(a,decision)).rejects.toThrow("Accounting incomplete");
  expect(await prisma.financialCase.findUnique({where:{id:decision.caseId}})).toMatchObject({status:"VERIFIED"});
  expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({refundedCents:0});
  await expect(remote.execute(f.transfer)).rejects.toThrow();
  const bank=await prisma.$transaction(tx=>prepareOperation(tx,{key:`payout:${f.batchId}:1`,kind:"FINANCE_PAYOUT",payload:{...(f.transfer.payload as object)}}));
  await expect(remote.execute(bank)).rejects.toThrow();
  expect(remote.create).toHaveBeenCalledTimes(0);expect(remote.ledger.size).toBe(0);
  expect(await prisma.financeIssue.findFirst({where:{kind:"ACCOUNTING_INCOMPLETE",reservationId:f.r.id}})).not.toBeNull();
  expect(await prisma.ledgerJournal.count({where:{hostId:f.h.hostProfile.id,kind:{in:["HOST_TRANSFER","HOST_PAYOUT"]}}})).toBe(0);
  await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
  expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({refundedCents:4500});
  await resolveFinancialCase(a,decision);
  await voidUndispatchedBatch(a.id,f.batchId,await code(a),"Refund accounting changed unpaid entitlement");
  const rebuilt=await createPayoutBatch(f.h.hostProfile.id),op=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+rebuilt.id}});
  expect(op.payload).toMatchObject({amount:9000});await remote.execute(op);await remote.execute(op);
  expect(remote.create).toHaveBeenCalledTimes(1);expect(remote.create.mock.calls[0][0].payload).toMatchObject({amount:9000});expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({state:"VOIDED",amountCents:13500,transferredCents:0});
 });
 it("refund observation winning the guard blocks a waiting transfer on another connection",async()=>{
  const f=await setup(),remote=provider(),entered=barrier(),release=barrier(),gate='refund-test:'+randomUUID();
  const trigger='refund_gate_'+f.r.id;
  // Pause the real successful observation inside PostgreSQL, after it owns the
  // reservation guard but before its transaction commits. No service is mocked.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."reservationId"='${f.r.id}' AND NEW.status='SUCCEEDED' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${gate}',0)); END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
  const held=one.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${gate},0))`;entered.release();await release.wait;},{timeout:15000});await entered.wait;
  const observation=externalRefund(f);const observed=Promise.allSettled([observation]);
  try{
   let paused=false;for(let n=0;n<400;n++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE%Refund%'`;if(rows.length){paused=true;break;}await new Promise(r=>setTimeout(r,10));}expect(paused).toBe(true);
   const dispatch=Promise.allSettled([remote.execute(f.transfer)]);await blockedSessions();release.release();await held;
   expect((await observed)[0].status).toBe('fulfilled');expect((await dispatch)[0].status).toBe('rejected');expect(remote.create).toHaveBeenCalledTimes(0);
  }finally{release.release();await held;await prisma.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "Refund"`);await prisma.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);}
 });
 it("dispatch winning the guard forces concurrent external refund into a durable post-transfer receivable",async()=>{
  const f=await setup(),remote=provider(),entered=barrier(),release=barrier(),original=remote.create.getMockImplementation()!;
  remote.create.mockImplementationOnce(async op=>{const result=await original(op);entered.release();await release.wait;return result;});
  const dispatch=remote.execute(f.transfer);await entered.wait;const refund=externalRefund(f);const refundOutcome=Promise.allSettled([refund]);
  try{await blockedSessions();}finally{release.release();}await dispatch;expect((await refundOutcome)[0].status).toBe("fulfilled");
  await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
  expect(remote.create).toHaveBeenCalledTimes(1);expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({amountCents:13500,transferredCents:13500});
  const issue=await prisma.financeIssue.findFirstOrThrow({where:{reservationId:f.r.id,kind:"POST_PAYOUT_REFUND"}});expect(issue.evidence).toMatchObject({hostCents:4500});
  const journal=await prisma.ledgerJournal.findFirstOrThrow({where:{reservationId:f.r.id,kind:"REFUND"},include:{lines:true}});expect(journal.lines.find(l=>l.account==="HOST_RECEIVABLE")?.debitCents).toBe(4500);
  expect((await withReservationLock(f.r.id,tx=>payoutEligibility(tx,f.r.id,{ignoreBatch:f.batchId}))).eligible).toBe(false);
 });
 it("multiple partial refunds and captures are accounted once and every newer receipt invalidates the checkpoint",async()=>{
  const f=await setup();await externalRefund(f,2000);await externalRefund(f,3000);
  for(const amount of [1000,2000])await prisma.payment.create({data:{reservationId:f.r.id,type:"DEPOSIT_CAPTURE",status:"SUCCEEDED",amountCents:amount}});
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(false);
  await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
  expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({refundedCents:4500,netCents:13500});
  expect(await prisma.ledgerJournal.count({where:{reservationId:f.r.id,kind:"REFUND"}})).toBe(2);expect(await prisma.ledgerJournal.count({where:{reservationId:f.r.id,kind:"DEPOSIT_CAPTURE"}})).toBe(2);
  const op=await prisma.$transaction(tx=>prepareOperation(tx,{key:randomUUID(),kind:"REFUND",reservationId:f.r.id,payload:{amount:100}}));await prisma.financialDispatch.create({data:{operationId:op.id,leaseToken:"crashed",phase:"SUCCEEDED",providerId:"re_unprojected",result:{id:"re_unprojected",status:"succeeded",amount:100}}});
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).reasons.join(" ")).toMatch(/receipt|projection/);
 });
});

describe("bank payout reversal crash recovery",()=>{
 it("confirmed failed bank recovery releases only tracked Connect funds for the approved reversal",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const bank=await planBankPayout(f.batchId);
  await expect(remote.execute(bank,true)).rejects.toThrow();const issue=await recoveryIssue(f,a);
  await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("Bank movement incomplete");
  remote.ledger.set(bank.key,{...remote.ledger.get(bank.key)!,status:"failed"});await remote.execute(bank);
  const planned=await planTransferReversal(a.id,issue.id,await code(a)),reversal=await prisma.payoutReversal.findUniqueOrThrow({where:{id:planned.id}}),op=await prisma.financialOperation.findUniqueOrThrow({where:{id:reversal.operationId!}});
  await remote.execute(op);await remote.execute(op);expect(remote.create).toHaveBeenCalledTimes(3);expect(remote.create.mock.calls.filter(([o])=>o.kind==="FINANCE_REVERSAL")).toHaveLength(1);
  expect(await memo(f.h.hostProfile.id)).toBe(9000);expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({paidCents:0,pendingBankCents:0,reversedCents:4500,reversalReservedCents:0});
 });
 it("projected pending bank funds and an unprocessed bank webhook both block reversals",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const bank=await planBankPayout(f.batchId),original=remote.create.getMockImplementation()!;
  remote.create.mockImplementationOnce(async op=>{const r={...await original(op),status:"pending"};remote.ledger.set(op.key,r);return r;});await remote.execute(bank);
  const issue=await recoveryIssue(f,a);await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("Bank movement incomplete");
  expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({pendingBankCents:13500,paidCents:0});
  remote.ledger.set(bank.key,{...remote.ledger.get(bank.key)!,status:"failed"});await remote.execute(bank);
  const event=await prisma.stripeEvent.create({data:{stripeEventId:randomUUID(),type:"payout.updated",status:"RECEIVED",payload:{data:{object:{id:remote.ledger.get(bank.key)!.id}}}}});
  try{await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("webhook");expect(remote.create).toHaveBeenCalledTimes(2);expect(await prisma.payoutReversal.count({where:{batchId:f.batchId}})).toBe(0);}finally{await prisma.stripeEvent.delete({where:{id:event.id}});}
  const unmatched=await prisma.financeIssue.create({data:{key:"unmatched-bank:"+randomUUID(),kind:"UNMATCHED_PROVIDER_OBJECT",reason:"Bank event arrived before provider ownership was reconciled"}});
  try{await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("reconciliation unresolved");expect(remote.create).toHaveBeenCalledTimes(2);}finally{await prisma.financeIssue.delete({where:{id:unmatched.id}});}
 });
 it.each(["reject-first","recover-first"])("accepted bank payout with real SQL projection failure converges safely: %s",async order=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const bank=await planBankPayout(f.batchId);
  await expect(remote.execute(bank,true)).rejects.toThrow();
  expect(await prisma.financialDispatch.count({where:{operationId:bank.id,phase:"SUCCEEDED"}})).toBe(1);
  expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({state:"TRANSFERRED",paidCents:0});
  const issue=await recoveryIssue(f,a);
  if(order==="reject-first"){
   await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("Bank movement incomplete");
   expect(await prisma.financeIssue.findUnique({where:{key:"bank-movement:"+f.batchId}})).toMatchObject({status:"OPEN"});
   expect(await prisma.payoutReversal.count({where:{batchId:f.batchId}})).toBe(0);
  }
  await remote.execute(bank);
  await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("Insufficient projected Connect funds");
  expect(remote.create).toHaveBeenCalledTimes(2);expect(remote.create.mock.calls.filter(([o])=>o.kind==="FINANCE_REVERSAL")).toHaveLength(0);
  expect(await prisma.ledgerJournal.count({where:{hostId:f.h.hostProfile.id,kind:"TRANSFER_REVERSAL"}})).toBe(0);
  expect(await memo(f.h.hostProfile.id)).toBe(0);expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({transferredCents:13500,paidCents:13500,pendingBankCents:0,reversedCents:0,reversalReservedCents:0});
  expect(await prisma.financeIssue.findUnique({where:{id:issue.id}})).toMatchObject({status:"OPEN"});
 });
 it("reversal dispatch also rejects an existing reservation when bank acceptance has no projection",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const issue=await recoveryIssue(f,a),planned=await planTransferReversal(a.id,issue.id,await code(a));
  const reversal=await prisma.payoutReversal.findUniqueOrThrow({where:{id:planned.id}}),op=await prisma.financialOperation.findUniqueOrThrow({where:{id:reversal.operationId!}});
  // Represents an older generation receipt discovered after reversal planning.
  const bank=await prisma.$transaction(tx=>prepareOperation(tx,{key:`payout:${f.batchId}:0`,kind:"FINANCE_PAYOUT",payload:{...(f.transfer.payload as object)}}));
  await prisma.financialDispatch.create({data:{operationId:bank.id,leaseToken:"old-worker",phase:"DISPATCHED"}});
  await expect(remote.execute(op)).rejects.toThrow("Bank movement incomplete");expect(remote.create).toHaveBeenCalledTimes(1);expect(await memo(f.h.hostProfile.id)).toBe(13500);
 });
 it("recovery and reversal reservation really contend on separate sessions and converge without duplicate movement",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const bank=await planBankPayout(f.batchId);await expect(remote.execute(bank,true)).rejects.toThrow();const issue=await recoveryIssue(f,a),auth=await code(a);
  const entered=barrier(),release=barrier();const held=one.$transaction(async tx=>{await lockFinanceOperation(tx,bank);entered.release();await release.wait;},{timeout:15000});await entered.wait;
  const outcomes=Promise.allSettled([remote.execute(bank),planTransferReversal(a.id,issue.id,auth,two)]);
  try{await blockedSessions(2);}finally{release.release();}await held;const settled=await outcomes;expect(settled[0].status).toBe("fulfilled");expect(settled[1].status).toBe("rejected");
  expect(remote.create).toHaveBeenCalledTimes(2);expect(await prisma.payoutReversal.count({where:{batchId:f.batchId}})).toBe(0);expect(await memo(f.h.hostProfile.id)).toBe(0);
 });
 it("unknown retrieval blocks reversal and a failed earlier generation cannot hide a later accepted generation",async()=>{
  const f=await setup(),a=await admin(),remote=provider();await remote.execute(f.transfer);const first=await planBankPayout(f.batchId);
  const original=remote.create.getMockImplementation()!;remote.create.mockImplementationOnce(async op=>{const r={...await original(op),status:"failed"};remote.ledger.set(op.key,r);return r;});await remote.execute(first);
  const failed=remote.ledger.get(first.key)!;external.bank.mockResolvedValue({id:failed.id,amount:failed.amount,currency:failed.currency,status:'failed',metadata:{hostId:failed.hostId,operationKey:failed.operationKey}});
  await retryBankPayout(a.id,f.batchId,await code(a));
  const later=await planBankPayout(f.batchId);await expect(remote.execute(later,true)).rejects.toThrow();remote.retrieve.mockRejectedValueOnce(Error("Provider cannot classify outcome"));await expect(remote.execute(later)).rejects.toThrow("cannot classify");
  const issue=await recoveryIssue(f,a);await expect(planTransferReversal(a.id,issue.id,await code(a))).rejects.toThrow("Bank movement incomplete");
  expect(remote.create).toHaveBeenCalledTimes(3);expect(await prisma.payoutBankProjection.count({where:{batchId:f.batchId,status:"failed"}})).toBe(1);expect((await bankMovement(prisma,f.batchId)).complete).toBe(false);
  await remote.execute(later);expect(await memo(f.h.hostProfile.id)).toBe(0);expect((await bankMovement(prisma,f.batchId)).paidCents).toBe(13500);
 });
 it("the database rejects concurrent materialized over-reservation without restricting reversing journals",async()=>{
  const f=await setup(),remote=provider();await remote.execute(f.transfer);const entered=barrier(),release=barrier();
  const held=prisma.$transaction(async tx=>{await lockPayoutReservations(tx,[f.r.id],f.h.hostProfile.id);entered.release();await release.wait;},{timeout:15000});await entered.wait;
  const reserve=(db:typeof one)=>db.$transaction(async tx=>{await lockPayoutReservations(tx,[f.r.id],f.h.hostProfile.id);return tx.payoutBatch.update({where:{id:f.batchId},data:{reversalReservedCents:{increment:9000}}});});
  const pending=Promise.allSettled([reserve(one),reserve(two)]);try{await blockedSessions(2);}finally{release.release();}await held;
  const results=await pending;expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);expect(await prisma.payoutBatch.findUnique({where:{id:f.batchId}})).toMatchObject({reversalReservedCents:9000});expect(remote.create).toHaveBeenCalledTimes(1);
 });
});
