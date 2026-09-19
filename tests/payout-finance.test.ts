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
import { runOperation } from "@/lib/financial-operations";
import { processOutboxOnce } from "@/lib/outbox";
import { financeHost } from "@/lib/finance-access";
import { issueFinanceDocument,readFinanceDocument } from "@/lib/finance-documents";
const remote=vi.hoisted(()=>({create:vi.fn(),retrieve:vi.fn(),discover:vi.fn()}));
vi.mock("@/lib/finance-provider",async original=>({...await original<object>(),verifyFinanceDestination:async()=>{},createFinanceProviderObject:remote.create,retrieveFinanceProviderObject:remote.retrieve,discoverFinanceProviderObject:remote.discover}));
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
async function fixture(){
 const h=await createTestHost(),customer=await createTestCustomer();users.push(h.user.id,customer.id);hosts.push(h.hostProfile.id);const v=await createTestVehicle({hostId:h.hostProfile.id});vehicles.push(v.id);
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date("2041-01-01"),returnAt:new Date("2041-01-04"),status:"COMPLETED"});
 await prisma.trip.create({data:{reservationId:r.id,startedAt:new Date(Date.now()-86400000*4),endedAt:new Date(Date.now()-86400000*2)}});
 await prisma.tripEvent.create({data:{reservationId:r.id,type:"RETURN_REVIEWED",actorId:h.user.id}});
 for(const [submittedById,submittedByRole]of [[customer.id,"CUSTOMER"],[h.user.id,"HOST"]]as const)await prisma.conditionReport.create({data:{reservationId:r.id,phase:"POST_TRIP",submittedById,submittedByRole,acceptedAt:new Date(),mileage:500,fuelLevel:100,photos:{create:[{category:"EXTERIOR",storageKey:"local:finance-fixture"},{category:"INTERIOR",storageKey:"local:finance-fixture"}]}}});
 const payment=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:r.totalCents}});
 await prisma.financeQuote.create({data:{reservationId:r.id,terms:{commission:{version:1},tax:{version:1},settlement:{delayDays:1,minimumCents:1,loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:true}},amounts:{grossCents:15000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1500,hostNetCents:13500,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:15000},approved:true}}});
 await withReservationLock(r.id,tx=>accountReservation(tx,r.id));
 await prisma.connectAccount.create({data:{hostId:h.hostProfile.id,accountId:"acct_"+randomUUID(),detailsSubmitted:true,payoutsEnabled:true,verificationStatus:"VERIFIED",synchronizedAt:new Date(),minimumCents:1}});
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
 const planned=await planTransferReversal(admin.id,issue.id,"123456");expect(await planTransferReversal(admin.id,issue.id,"123456")).toEqual(planned);const reversal=await prisma.payoutReversal.findUniqueOrThrow({where:{id:planned.id}}),op=await prisma.financialOperation.findUniqueOrThrow({where:{id:reversal.operationId!}});
 expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({reversalReservedCents:4500});remote.create.mockResolvedValueOnce({...observed,id:"trr_"+randomUUID(),kind:op.kind,operationKey:op.key,amount:4500,status:"reversed",amountReversed:4500});await executeFinanceOperation(op);expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({reversedCents:4500,reversalReservedCents:0});expect(await prisma.financeIssue.findUnique({where:{id:issue.id}})).toMatchObject({status:"RESOLVED"});
 const bank=await planBankPayout(b.id!);expect(bank.payload).toMatchObject({amount:9000});remote.create.mockResolvedValueOnce({...observed,id:"po_"+randomUUID(),kind:bank.kind,operationKey:bank.key,amount:9000,status:"paid"});await executeFinanceOperation(bank);expect(await prisma.payoutBatch.findUnique({where:{id:b.id!}})).toMatchObject({state:"PAID",paidCents:9000,transferredCents:13500,reversedCents:4500});
 await prisma.authCode.deleteMany({where:{email:admin.email}});
});
