import { hostYearToDate } from "@/lib/finance-reporting";
import type Stripe from "stripe";
import * as financeProvider from "@/lib/finance-provider";
import { handleFinanceEvent } from "@/lib/finance-webhooks";
import { allocateChargeback,proposeAdjustment,approveAdjustment,resolveFinanceIssue,retryScheduledFinance } from "@/lib/finance-admin";
import { financeQuote,freezeFinance } from "@/lib/finance-rules";
import { calculatePricing } from "@/lib/pricing";
import { afterAll,afterEach,expect,it,vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma,createTestHost,createTestCustomer,createTestVehicle,createTestReservation,cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { withReservationLock } from "@/lib/financial-locks";
import { accountReservation } from "@/lib/finance-ledger";
import { createPayoutBatch,executeFinanceOperation,applyFinanceObject,planTransferReversal,planBankPayout } from "@/lib/payout-operations";
import { payoutEligibility,lockFinanceOperation } from "@/lib/payout-authority";
import { runOperation,prepareOperation } from "@/lib/financial-operations";
import { processOutboxOnce } from "@/lib/outbox";
import { financeHost } from "@/lib/finance-access";
import { issueFinanceDocument,readFinanceDocument } from "@/lib/finance-documents";
const remote=vi.hoisted(()=>({create:vi.fn(),retrieve:vi.fn(),discover:vi.fn()}));
// Even indirect provider preflight imports use a controlled Stripe boundary.
// Account ownership still comes from real PostgreSQL fixtures; no SDK request
// in this integration suite can reach Stripe with a synthetic key.
vi.mock("stripe",()=>{
 type Result={id:string;operationKey:string;hostId:string;accountId:string;amount:number;currency:string;amountReversed:number;status:string};
 const metadata=(r:Result)=>({operationKey:r.operationKey,hostId:r.hostId});
 const transfer=(r:Result)=>({id:r.id,metadata:metadata(r),destination:r.accountId,amount:r.amount,currency:r.currency,amount_reversed:r.amountReversed,reversed:r.amountReversed===r.amount});
 const payout=(r:Result)=>({id:r.id,metadata:metadata(r),amount:r.amount,currency:r.currency,status:r.status});
 const reversal=(r:Result)=>({id:r.id,metadata:metadata(r),amount:r.amount,currency:r.currency});
 async function* discover(project:(r:Result)=>unknown){const result=await remote.discover();if(result)yield project(result);}
 return {default:class {
  accounts={retrieve:async(id:string)=>{const {prisma}=await import("./helpers/factories");const a=await prisma.connectAccount.findUniqueOrThrow({where:{accountId:id}});return {id,metadata:{hostId:a.hostId},payouts_enabled:a.payoutsEnabled,details_submitted:a.detailsSubmitted,requirements:{disabled_reason:null},settings:{payouts:{schedule:{interval:"manual"}}}};}};
  balance={retrieve:async()=>({available:[{currency:"usd",amount:100000000}]})};
  transfers={create:async()=>transfer(await remote.create()),retrieve:async()=>transfer(await remote.retrieve()),list:()=>discover(transfer),createReversal:async()=>reversal(await remote.create()),retrieveReversal:async()=>reversal(await remote.retrieve()),listReversals:()=>discover(reversal)};
  payouts={create:async()=>payout(await remote.create()),retrieve:async()=>payout(await remote.retrieve()),list:()=>discover(payout)};
 }};
});
const one=new PrismaClient(),two=new PrismaClient(),users:string[]=[],hosts:string[]=[],vehicles:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();remote.create.mockReset();remote.retrieve.mockReset();remote.discover.mockReset();});
afterAll(async()=>{
 // Only the disposable test database may truncate immutable financial fixtures.
 // No production service exposes this teardown capability.
 const db=(await prisma.$queryRaw<Array<{name:string}>>`SELECT current_database() name`)[0].name;
 if(!db.endsWith("_test"))throw new Error("Financial fixtures require an isolated _test database");
 await prisma.$executeRawUnsafe('TRUNCATE "FinanceDocument","LedgerLine","LedgerJournal","PayoutItem","PayoutReversal","PayoutBatch","HostEarning","FinanceObject","FinanceIssue","FinanceAdjustment","ProviderDispute","ConnectAccount","FinanceGrant" CASCADE');
 await prisma.financialOperation.deleteMany({where:{kind:{startsWith:"FINANCE_"},payload:{path:["hostId"],string_starts_with:""}}});
 await cleanupReservationsForVehicles(vehicles);await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.hostEmployee.deleteMany({where:{hostId:{in:hosts}}});await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.hostProfile.deleteMany({where:{id:{in:hosts}}});await prisma.user.deleteMany({where:{id:{in:users}}});await Promise.all([one.$disconnect(),two.$disconnect(),prisma.$disconnect()]);
});
async function fixture(reuse?:{h:Awaited<ReturnType<typeof createTestHost>>;customer:Awaited<ReturnType<typeof createTestCustomer>>;v:Awaited<ReturnType<typeof createTestVehicle>>},stripePaymentIntentId?:string){
 const h=reuse?.h??await createTestHost(),customer=reuse?.customer??await createTestCustomer();const v=reuse?.v??await createTestVehicle({hostId:h.hostProfile.id});if(!reuse){users.push(h.user.id,customer.id);hosts.push(h.hostProfile.id);vehicles.push(v.id);}
 const offset=reuse?await prisma.reservation.count({where:{vehicleId:v.id}}):0;
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date(Date.UTC(2041,0,1+offset*4)),returnAt:new Date(Date.UTC(2041,0,4+offset*4)),status:"COMPLETED"});
 await prisma.trip.create({data:{reservationId:r.id,startedAt:new Date(Date.now()-86400000*4),endedAt:new Date(Date.now()-86400000*2)}});
 await prisma.tripEvent.create({data:{reservationId:r.id,type:"RETURN_REVIEWED",actorId:h.user.id}});
 for(const [submittedById,submittedByRole]of [[customer.id,"CUSTOMER"],[h.user.id,"HOST"]]as const)await prisma.conditionReport.create({data:{reservationId:r.id,phase:"POST_TRIP",submittedById,submittedByRole,acceptedAt:new Date(),mileage:500,fuelLevel:100,photos:{create:[{category:"EXTERIOR",storageKey:"local:finance-fixture"},{category:"INTERIOR",storageKey:"local:finance-fixture"}]}}});
 const payment=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:r.totalCents,stripePaymentIntentId}});
 await prisma.financeQuote.create({data:{reservationId:r.id,terms:{commission:{version:1},tax:{version:1},settlement:{delayDays:1,minimumCents:1,loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:true}},amounts:{grossCents:15000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1500,hostNetCents:13500,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:15000},approved:true}}});
 await withReservationLock(r.id,tx=>accountReservation(tx,r.id));
 if(!reuse)await prisma.connectAccount.create({data:{hostId:h.hostProfile.id,accountId:"acct_"+randomUUID(),detailsSubmitted:true,payoutsEnabled:true,verificationStatus:"VERIFIED",synchronizedAt:new Date(),minimumCents:1}});
 return {h,customer,v,r,payment};
}
it("approves only settled completed returns and holds a new claim or suspended host",async()=>{
 const f=await fixture();expect((await withReservationLock(f.r.id,tx=>payoutEligibility(tx,f.r.id))).eligible).toBe(true);
 const c=await prisma.serviceCase.create({data:{kind:"CLAIM",reservationId:f.r.id,vehicleId:f.v.id,openedById:f.customer.id,category:"DAMAGE",title:"Claim fixture",details:{},dueAt:new Date(),retainUntil:new Date()}});
 expect((await withReservationLock(f.r.id,tx=>payoutEligibility(tx,f.r.id))).eligible).toBe(false);await prisma.serviceCase.delete({where:{id:c.id}});
 await prisma.user.update({where:{id:f.h.user.id},data:{isActive:false}});expect((await withReservationLock(f.r.id,tx=>payoutEligibility(tx,f.r.id))).eligible).toBe(false);
});
it("separate payout workers contend at the actual database barrier and reserve earnings once",async()=>{
 const f=await fixture(),entered=barrier(),release=barrier();
 const held=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT financial_guard_xact(${"vehicle:"+f.v.id})`;entered.release();await release.wait;},{timeout:15000});await entered.wait;
 const first=createPayoutBatch(f.h.hostProfile.id,one),second=createPayoutBatch(f.h.hostProfile.id,two);let pids:number[]=[];
 try{for(let n=0;n<300;n++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;pids=[...new Set(rows.map(x=>x.pid))];if(pids.length>=2)break;await new Promise(r=>setTimeout(r,10));}expect(pids.length).toBeGreaterThanOrEqual(2);}finally{release.release();}
 await held;const results=await Promise.all([first,second]);expect(results.filter(r=>r.id)).toHaveLength(1);expect(await prisma.payoutItem.count({where:{reservationId:f.r.id,active:true}})).toBe(1);
});
it("lost provider response is discovered without creating a second transfer",async()=>{
 vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");const f=await fixture(),batch=await createPayoutBatch(f.h.hostProfile.id),op=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+batch.id}}),p=op.payload as {hostId:string;accountId:string;amount:number;currency:string};
 const result={id:"tr_"+randomUUID(),operationKey:op.key,kind:op.kind,hostId:p.hostId,accountId:p.accountId,status:"transferred",amount:p.amount,currency:p.currency,amountReversed:0};const providerLedger=new Map<string,typeof result>();remote.create.mockImplementationOnce(async()=>{providerLedger.set(op.key,result);throw new Error("Lost response after provider accepted");});remote.discover.mockImplementation(async()=>providerLedger.get(op.key)??null);
 await expect(executeFinanceOperation(op)).rejects.toThrow("Lost response");expect(await prisma.financialDispatch.count({where:{operationId:op.id,phase:"DISPATCHED"}})).toBe(1);await executeFinanceOperation(op);expect(remote.create).toHaveBeenCalledTimes(1);expect(remote.discover).toHaveBeenCalledTimes(1);expect(await prisma.payoutBatch.findUnique({where:{id:batch.id!}})).toMatchObject({transferId:result.id,transferredCents:13500});
});
it("undiscovered dispatched outcome enters review without blind replay",async()=>{
 vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");const f=await fixture(),b=await createPayoutBatch(f.h.hostProfile.id),op=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+b.id}});await prisma.financialDispatch.create({data:{operationId:op.id,leaseToken:"lost-worker",phase:"DISPATCHED"}});remote.discover.mockResolvedValue(null);await expect(executeFinanceOperation(op)).rejects.toThrow("unknown");expect(remote.create).not.toHaveBeenCalled();expect(await prisma.financialOperation.findUnique({where:{id:op.id}})).toMatchObject({state:"REVIEW"});
});
it("provider acceptance survives a real projection rollback and recovery retrieves the same object",async()=>{
 vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");const f=await fixture(),b=await createPayoutBatch(f.h.hostProfile.id),op=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+b.id}}),p=op.payload as {hostId:string;accountId:string;amount:number;currency:string};
 const accepted={id:"tr_"+randomUUID(),kind:op.kind,operationKey:op.key,hostId:p.hostId,accountId:p.accountId,amount:p.amount,currency:p.currency,status:"transferred",amountReversed:0};const providerLedger=new Map<string,typeof accepted>();
 const create=vi.fn(async()=>{providerLedger.set(op.key,accepted);return accepted;});
 await expect(runOperation(op,{create,retrieve:async()=>accepted,discover:async()=>providerLedger.get(op.key)??null,apply:async(tx,result)=>{await applyFinanceObject(tx,op,result);await tx.$executeRawUnsafe("SELECT 1 / 0");}})).rejects.toThrow();
 expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({transferredCents:0});expect(await prisma.ledgerJournal.count({where:{providerId:accepted.id}})).toBe(0);expect(await prisma.financialDispatch.count({where:{operationId:op.id,phase:"SUCCEEDED",providerId:accepted.id}})).toBe(1);expect(await prisma.financialOperation.findUnique({where:{id:op.id}})).toMatchObject({providerId:accepted.id});
 remote.retrieve.mockResolvedValue(accepted);await executeFinanceOperation(op);expect(create).toHaveBeenCalledTimes(1);expect(remote.create).not.toHaveBeenCalled();expect(providerLedger.size).toBe(1);expect(await prisma.ledgerJournal.count({where:{providerId:accepted.id}})).toBe(1);
});
it("a stale retrieval worker cannot overwrite a successor after separate-session lease takeover",async()=>{
 vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");const f=await fixture(),b=await createPayoutBatch(f.h.hostProfile.id),op=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+b.id}}),p=op.payload as {hostId:string;accountId:string;amount:number;currency:string};const result={id:"tr_"+randomUUID(),kind:op.kind,operationKey:op.key,hostId:p.hostId,accountId:p.accountId,amount:p.amount,currency:p.currency,status:"transferred",amountReversed:0};
 remote.create.mockResolvedValue(result);await executeFinanceOperation(op);const entered=barrier(),release=barrier();remote.retrieve.mockImplementationOnce(async()=>{entered.release();await release.wait;return result;}).mockResolvedValue(result);
 const stale=executeFinanceOperation(op);const outcome=Promise.allSettled([stale]);await entered.wait;
 await two.$transaction(async tx=>{await lockFinanceOperation(tx,op);await tx.financialOperation.update({where:{id:op.id},data:{leaseExpiresAt:new Date(0)}});});
 await executeFinanceOperation(op);const successor=await prisma.financialOperation.findUniqueOrThrow({where:{id:op.id}});release.release();expect((await outcome)[0].status).toBe("rejected");expect(await prisma.financialOperation.findUniqueOrThrow({where:{id:op.id}})).toEqual(successor);expect(remote.create).toHaveBeenCalledTimes(1);
});
it("refund accounting reduces pending earnings exactly once",async()=>{const f=await fixture();await prisma.refund.create({data:{reservationId:f.r.id,paymentId:f.payment.id,amountCents:5000,status:"SUCCEEDED",reason:"Fixture refund",idempotencyKey:randomUUID()}});await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({refundedCents:4500});expect((await withReservationLock(f.r.id,tx=>payoutEligibility(tx,f.r.id))).amountCents).toBe(9000);});
it("employee access requires explicit finance permission and current membership",async()=>{const f=await fixture(),employee=await createTestCustomer({role:"HOST_EMPLOYEE"});users.push(employee.id);const membership=await prisma.hostEmployee.create({data:{hostId:f.h.hostProfile.id,userId:employee.id,role:"MANAGER"}});await expect(financeHost(prisma,employee.id)).rejects.toThrow("permission");await prisma.financeGrant.create({data:{hostId:f.h.hostProfile.id,userId:employee.id,manage:true,grantedById:f.h.user.id}});expect((await financeHost(prisma,employee.id,undefined,true)).host.id).toBe(f.h.hostProfile.id);await prisma.hostEmployee.update({where:{id:membership.id},data:{isActive:false}});await expect(financeHost(prisma,employee.id)).rejects.toThrow();});
it("private statement denies another host and preserves the issued PDF",async()=>{const f=await fixture(),other=await createTestHost();users.push(other.user.id);hosts.push(other.hostProfile.id);const doc=await issueFinanceDocument(f.h.user.id,{kind:"EARNINGS_STATEMENT",reservationId:f.r.id});await expect(readFinanceDocument(other.user.id,doc.id)).rejects.toThrow();const own=await readFinanceDocument(f.h.user.id,doc.id);expect(Buffer.from(own.pdf).subarray(0,4).toString()).toBe("%PDF");await expect(prisma.financeDocument.update({where:{id:doc.id},data:{contentHash:"changed"}})).rejects.toThrow("Immutable");});
it("expired scheduled work resumes through the approved outbox worker and commits its completion with one batch",async()=>{
 const f=await fixture(),message=await prisma.outboxMessage.create({data:{type:"finance_schedule",deliveryKey:randomUUID(),payload:{hostId:f.h.hostProfile.id,cutoff:new Date().toISOString()},attempts:1,leaseToken:"crashed-scheduler",leaseExpiresAt:new Date(0)}});
 expect(await processOutboxOnce(1,[message.id],one)).toMatchObject({processed:1,failed:0});expect(await prisma.outboxMessage.findUnique({where:{id:message.id}})).toMatchObject({status:"SENT",leaseToken:null});expect(await prisma.payoutBatch.count({where:{hostId:f.h.hostProfile.id}})).toBe(1);
 await processOutboxOnce(1,[message.id],two);expect(await prisma.payoutBatch.count({where:{hostId:f.h.hostProfile.id}})).toBe(1);
});
it("a stale outbox token creates no payout batch",async()=>{const f=await fixture(),cutoff=new Date(),message=await prisma.outboxMessage.create({data:{type:"finance_schedule",deliveryKey:randomUUID(),payload:{hostId:f.h.hostProfile.id,cutoff:cutoff.toISOString()},leaseToken:"successor",leaseExpiresAt:new Date(Date.now()+60000)}});await expect(createPayoutBatch(f.h.hostProfile.id,one,{id:message.id,token:"stale",cutoff})).rejects.toThrow("lease lost");expect(await prisma.payoutBatch.count({where:{hostId:f.h.hostProfile.id}})).toBe(0);await prisma.outboxMessage.delete({where:{id:message.id}});});
it("approved partial refund recovery reserves once, reverses once and pays only the unreversed remainder",async()=>{
 vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");const f=await fixture(),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);const b=await createPayoutBatch(f.h.hostProfile.id),transfer=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+b.id}}),p=transfer.payload as {hostId:string;accountId:string;amount:number;currency:string};
 const observed={id:"tr_"+randomUUID(),kind:transfer.kind,operationKey:transfer.key,hostId:p.hostId,accountId:p.accountId,amount:p.amount,currency:p.currency,status:"transferred",amountReversed:0};remote.create.mockResolvedValueOnce(observed);await executeFinanceOperation(transfer);
 await prisma.refund.create({data:{reservationId:f.r.id,paymentId:f.payment.id,amountCents:5000,status:"SUCCEEDED",reason:"Post-transfer refund",idempotencyKey:randomUUID()}});await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));const issue=await prisma.financeIssue.findFirstOrThrow({where:{reservationId:f.r.id,kind:"POST_PAYOUT_REFUND"}});
 await expect(planTransferReversal(admin.id,issue.id,"000000")).rejects.toThrow("step-up");
 await prisma.authCode.create({data:{email:admin.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
 const entered=barrier(),release=barrier();const held=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT financial_guard_xact(${"vehicle:"+f.v.id})`;entered.release();await release.wait;},{timeout:15000});await entered.wait;
 const first=planTransferReversal(admin.id,issue.id,"123456",one),second=planTransferReversal(admin.id,issue.id,"123456",two);
 try{let blocked=0;for(let n=0;n<300;n++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;blocked=new Set(rows.map(r=>r.pid)).size;if(blocked>=2)break;await new Promise(r=>setTimeout(r,10));}expect(blocked).toBeGreaterThanOrEqual(2);}finally{release.release();}
 await held;const [planned,replayed]=await Promise.all([first,second]);expect(replayed).toEqual(planned);const reversal=await prisma.payoutReversal.findUniqueOrThrow({where:{id:planned.id}}),op=await prisma.financialOperation.findUniqueOrThrow({where:{id:reversal.operationId!}});
 expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({reversalReservedCents:4500});remote.create.mockResolvedValueOnce({...observed,id:"trr_"+randomUUID(),kind:op.kind,operationKey:op.key,amount:4500,status:"reversed",amountReversed:4500});await executeFinanceOperation(op);expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({reversedCents:4500,reversalReservedCents:0});expect(await prisma.financeIssue.findUnique({where:{id:issue.id}})).toMatchObject({status:"RESOLVED"});
 const bank=await planBankPayout(b.id!);expect(bank.payload).toMatchObject({amount:9000});remote.create.mockResolvedValueOnce({...observed,id:"po_"+randomUUID(),kind:bank.kind,operationKey:bank.key,amount:9000,status:"paid"});await executeFinanceOperation(bank);expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({state:"PAID",paidCents:9000,transferredCents:13500,reversedCents:4500});
 const memo=await prisma.$queryRaw<Array<{balance:bigint}>>`SELECT COALESCE(sum(l."debitCents"-l."creditCents"),0)::bigint balance FROM "LedgerLine" l JOIN "LedgerJournal" j ON j.id=l."journalId" WHERE j."hostId"=${f.h.hostProfile.id} AND l.account='MEMO_CONNECT_FUNDS'`;expect(Number(memo[0].balance)).toBe(0);expect((await hostYearToDate(f.h.hostProfile.id)).rows).toEqual([{currency:"usd",grossCents:15000,paidCents:9000}]);
 expect(await planTransferReversal(admin.id,issue.id,"123456")).toEqual(planned);
 await prisma.authCode.deleteMany({where:{email:admin.email}});
});

it("a minimum spread across more than fifty reservations accumulates without starvation",async()=>{
 const f=await fixture();for(let n=0;n<50;n++)await fixture(f);
 await prisma.connectAccount.update({where:{hostId:f.h.hostProfile.id},data:{minimumCents:51*13500}});
 const first=await createPayoutBatch(f.h.hostProfile.id);expect(first.id).toBeNull();
 const second=await createPayoutBatch(f.h.hostProfile.id);expect(second.id).toBeTruthy();
 expect(await prisma.payoutItem.count({where:{batchId:second.id!}})).toBe(51);
 expect(await prisma.payoutBatch.findUnique({where:{id:second.id!}})).toMatchObject({amountCents:51*13500});
},90000);
it("an authorized employee cannot manage finance after the host owner is suspended",async()=>{
 const f=await fixture(),employee=await createTestCustomer({role:"HOST_EMPLOYEE"});users.push(employee.id);
 await prisma.hostEmployee.create({data:{hostId:f.h.hostProfile.id,userId:employee.id,role:"MANAGER"}});
 await prisma.financeGrant.create({data:{hostId:f.h.hostProfile.id,userId:employee.id,manage:true,grantedById:f.h.user.id}});
 await prisma.user.update({where:{id:f.h.user.id},data:{isActive:false}});
 await expect(financeHost(prisma,employee.id,undefined,true)).rejects.toThrow("active host");
});

it("new commission and jurisdiction tax versions cannot rewrite committed checkout snapshots",async()=>{
 const f=await fixture(),before=await prisma.financeSnapshot.findUniqueOrThrow({where:{reservationId:f.r.id}}),location="Tax fixture "+randomUUID();
 await prisma.vehicle.update({where:{id:f.v.id},data:{location}});
 await prisma.financeRule.create({data:{kind:"COMMISSION",scope:"HOST",scopeId:f.h.hostProfile.id,version:2,config:{basisPoints:2500,fixedCents:100,minimumCents:0,maximumCents:100000,hostDiscountBps:0},effectiveAt:new Date(0),approvedAt:new Date(),approvedById:f.h.user.id,createdById:f.h.user.id}});
 await prisma.financeRule.create({data:{kind:"TAX",scope:"JURISDICTION",scopeId:location,version:2,config:{jurisdiction:location,rentalBps:875,feeBps:500,extrasTaxable:true,exemptionsAllowed:false,provider:"CONFIGURED"},effectiveAt:new Date(0),approvedAt:new Date(),approvedById:f.h.user.id,createdById:f.h.user.id}});
 const vehicle=await prisma.vehicle.findUniqueOrThrow({where:{id:f.v.id}}),base=calculatePricing({vehicle,pickupAt:f.r.pickupAt,returnAt:f.r.returnAt});
 const next=await prisma.$transaction(tx=>financeQuote(tx,vehicle,base,f.customer.id));expect(next.terms.commission.version).toBe(2);expect(next.terms.tax.version).toBe(2);expect(next.breakdown.taxCents).toBeGreaterThan(0);
 expect(await withReservationLock(f.r.id,tx=>freezeFinance(tx,f.r.id))).toEqual(before);
 await expect(prisma.financeSnapshot.update({where:{reservationId:f.r.id},data:{tax:{version:2}}})).rejects.toThrow("Immutable");
});
it("additional collection is a liability until an approved allocation, never automatic host income",async()=>{
 const f=await fixture(),before=await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}}),payment=await prisma.payment.create({data:{reservationId:f.r.id,type:"ADDITIONAL_CHARGE",status:"SUCCEEDED",amountCents:2500}});
 await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
 const posted=await prisma.ledgerJournal.findUniqueOrThrow({where:{key:"payment:"+payment.id},include:{lines:true}});expect(posted.lines).toEqual(expect.arrayContaining([expect.objectContaining({account:"ADDITIONAL_CHARGE_LIABILITY",creditCents:2500})]));expect(await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}})).toEqual(before);
});

it("provider disputes hold earnings and lost disputes require independent step-up allocation",async()=>{
 const intentId="pi_"+randomUUID(),id="dp_"+randomUUID(),chargeId="ch_"+randomUUID(),f=await fixture(undefined,intentId),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
 let status="needs_response";const provider={disputes:{retrieve:vi.fn(async()=>({id,charge:chargeId,currency:"usd",amount:5000,status}))},charges:{retrieve:vi.fn(async()=>({id:chargeId,payment_intent:intentId}))}};
 vi.spyOn(financeProvider,"financeStripe").mockReturnValue(provider as unknown as Stripe);
 const event={id:"evt_"+randomUUID(),type:"charge.dispute.updated",data:{object:{id}}} as Stripe.Event;
 await handleFinanceEvent(event);expect((await withReservationLock(f.r.id,tx=>payoutEligibility(tx,f.r.id))).reasons).toContain("Stripe chargeback or dispute active");
 status="lost";await handleFinanceEvent(event);const issue=await prisma.financeIssue.findUniqueOrThrow({where:{key:"chargeback-allocation:"+id}});
 await expect(allocateChargeback(admin.id,issue.id,"000000")).rejects.toThrow("step-up");expect(await prisma.ledgerJournal.count({where:{key:"chargeback-allocation:"+id}})).toBe(0);
 await prisma.authCode.create({data:{email:admin.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
 await allocateChargeback(admin.id,issue.id,"123456");await handleFinanceEvent(event);
 expect(await prisma.financeIssue.findUnique({where:{id:issue.id}})).toMatchObject({status:"RESOLVED"});expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({adjustmentCents:-5000});
 await prisma.authCode.deleteMany({where:{email:admin.email}});
});
it("manual adjustment needs independent approval, a fresh code and remaining amount-specific evidence",async()=>{
 const f=await fixture(),proposer=await createTestCustomer({role:"SUPER_ADMIN"}),approver=await createTestCustomer({role:"SUPER_ADMIN"});users.push(proposer.id,approver.id);
 const evidence=await prisma.financialCase.create({data:{sourceKey:randomUUID(),reservationId:f.r.id,customerId:f.customer.id,kind:"SETTLEMENT",amountCents:1000,currency:"usd",reason:"Approved settlement fixture",status:"RESOLVED",resolution:"Approved evidence"}});
 const input={reservationId:f.r.id,kind:"HOST_CREDIT",amountCents:750,reason:"Approved service credit adjustment",evidenceId:evidence.id};const a=await proposeAdjustment(proposer.id,input);
 await expect(approveAdjustment(proposer.id,a.id,"123456")).rejects.toThrow("independent second");await expect(approveAdjustment(approver.id,a.id,"000000")).rejects.toThrow("step-up");expect(await prisma.ledgerJournal.count({where:{key:"adjustment:"+a.id}})).toBe(0);
 await prisma.authCode.create({data:{email:approver.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});await approveAdjustment(approver.id,a.id,"123456");
 const excess=await proposeAdjustment(proposer.id,input);await expect(approveAdjustment(approver.id,excess.id,"123456")).rejects.toThrow("remaining approved");expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({adjustmentCents:750});await prisma.authCode.deleteMany({where:{email:approver.email}});
});

it("deposit generations retain authorization and release evidence independently",async()=>{
 const f=await fixture(),first="pi_"+randomUUID(),second="pi_"+randomUUID();
 await withReservationLock(f.r.id,async tx=>{
  for(const id of [first,second]){const op=await prepareOperation(tx,{key:"deposit-fixture:"+id,kind:"DEPOSIT",reservationId:f.r.id,payload:{amount:5000,currency:"usd"}});await tx.financialOperation.update({where:{id:op.id},data:{providerId:id,state:"OBSERVED",result:{id,status:"requires_capture"}}});}
  await accountReservation(tx,f.r.id);
  const release=await prepareOperation(tx,{key:"release-fixture:"+first,kind:"DEPOSIT_RELEASE",reservationId:f.r.id,payload:{intentId:first}});await tx.financialOperation.update({where:{id:release.id},data:{providerId:first,state:"OBSERVED",result:{id:first,status:"canceled"}}});await accountReservation(tx,f.r.id);
 });
 await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
 expect(await prisma.ledgerJournal.count({where:{reservationId:f.r.id,kind:"DEPOSIT_AUTHORIZATION"}})).toBe(2);expect(await prisma.ledgerJournal.count({where:{key:"deposit-release:"+first}})).toBe(1);expect(await prisma.ledgerJournal.count({where:{key:"deposit-release:"+second}})).toBe(0);
});

it("raw earning updates cannot rewrite the frozen allocation or overdraw its adjusted balance",async()=>{const f=await fixture();await expect(prisma.hostEarning.update({where:{reservationId:f.r.id},data:{netCents:999999}})).rejects.toThrow("Immutable earning origin");await expect(prisma.hostEarning.update({where:{reservationId:f.r.id},data:{adjustmentCents:-13501}})).rejects.toThrow("earning_amounts_nonnegative");expect(await prisma.hostEarning.findUnique({where:{reservationId:f.r.id}})).toMatchObject({netCents:13500,adjustmentCents:0});});

it("a never-dispatched old intent can resume after authorized correction without inventing a new provider key",async()=>{
 vi.stubEnv("FINANCE_SANDBOX_ENABLED","true");vi.stubEnv("STRIPE_SECRET_KEY","sk_test_fixture");const f=await fixture(),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);const batch=await createPayoutBatch(f.h.hostProfile.id),op=await prisma.financialOperation.findUniqueOrThrow({where:{key:"transfer:"+batch.id}});
 await prisma.$transaction(async tx=>{await lockFinanceOperation(tx,op);await tx.financialOperation.update({where:{id:op.id},data:{state:"REVIEW",consecutiveFailures:20,firstAttemptAt:new Date(Date.now()-48*3600000)}});});
 const issue=await prisma.financeIssue.create({data:{key:"operation:"+op.id,kind:"PROVIDER_UNCERTAIN",hostId:f.h.hostProfile.id,operationId:op.id,reason:"Configuration failed before any provider dispatch"}});
 await expect(resolveFinanceIssue(admin.id,issue.id,"000000","Corrected test account configuration")).rejects.toThrow("step-up");
 await prisma.authCode.create({data:{email:admin.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});await resolveFinanceIssue(admin.id,issue.id,"123456","Corrected test account configuration");
 const payload=op.payload as {hostId:string;accountId:string;amount:number;currency:string};remote.create.mockResolvedValue({id:"tr_"+randomUUID(),operationKey:op.key,kind:op.kind,hostId:payload.hostId,accountId:payload.accountId,amount:payload.amount,currency:payload.currency,amountReversed:0,status:"transferred"});await executeFinanceOperation(op);expect(remote.create).toHaveBeenCalledTimes(1);expect(remote.discover).not.toHaveBeenCalled();expect(await prisma.financialOperation.count({where:{key:op.key}})).toBe(1);await prisma.authCode.deleteMany({where:{email:admin.email}});
});
it("failed schedule delivery resumes through the same outbox record after step-up approval",async()=>{
 const f=await fixture(),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);const message=await prisma.outboxMessage.create({data:{type:"finance_schedule",status:"FAILED",attempts:5,deliveryKey:randomUUID(),payload:{hostId:f.h.hostProfile.id,cutoff:new Date().toISOString()}}});
 await expect(retryScheduledFinance(admin.id,message.id,"000000","Corrected provider configuration")).rejects.toThrow("step-up");await prisma.authCode.create({data:{email:admin.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});await retryScheduledFinance(admin.id,message.id,"123456","Corrected provider configuration");expect(await processOutboxOnce(1,[message.id],one)).toMatchObject({processed:1,failed:0});expect(await prisma.outboxMessage.findUnique({where:{id:message.id}})).toMatchObject({status:"SENT"});expect(await prisma.payoutBatch.count({where:{hostId:f.h.hostProfile.id}})).toBe(1);await prisma.authCode.deleteMany({where:{email:admin.email}});
});
