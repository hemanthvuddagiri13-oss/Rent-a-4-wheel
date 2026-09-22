import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from "vitest";
import {execFileSync} from "node:child_process";
import {readdirSync} from "node:fs";
import path from "node:path";
const observation=vi.hoisted(()=>({name:"accounting_outcomes_"+crypto.randomUUID().replaceAll("-","")+"_test",queries:[] as string[],provider:vi.fn(),expectedProviderFactories:0,paymentRead:vi.fn()}));
// Dependency wiring only: every query, lock, transaction and accounting worker
// runs against a separately migrated PostgreSQL database, without worker mocks.
vi.mock("@/lib/prisma",async()=>{
 const {PrismaClient}=await import("@prisma/client");
 const url=new URL(process.env.DIRECT_DATABASE_URL??process.env.DATABASE_URL!);url.pathname="/"+observation.name;
 const prisma=new PrismaClient({datasources:{db:{url:url.toString()}}}).$extends({query:{ledgerJournal:{async create({args,query}){
  const row=await query(args);observation.queries.push("journal.create");return row;
 }}}});
 return {prisma};
});
vi.mock("@/lib/finance-provider",async importOriginal=>({...await importOriginal<typeof import("@/lib/finance-provider")>(),financeStripe:observation.provider}));
vi.mock("@/lib/stripe",async importOriginal=>({...await importOriginal<typeof import("@/lib/stripe")>(),stripe:{paymentIntents:{retrieve:observation.paymentRead}}}));
import {handlePaymentIntentFailed} from "@/lib/stripe-webhook-handlers";
import type Stripe from "stripe";
import {prisma} from "@/lib/prisma";
import {accountReservation,journal,reconcileAccounting} from "@/lib/finance-ledger";
import {withReservationLock} from "@/lib/financial-locks";
import {payoutEligibility} from "@/lib/payout-authority";
import {summarizeWorker,workerHttpStatus} from "@/lib/worker-result";
import {POST as cron} from "@/app/api/cron/payouts/[worker]/route";
import {PrismaClient} from "@prisma/client";
import {resolveFinanceIssue} from "@/lib/finance-admin";
import {certifyAccounting} from "@/lib/finance-completeness";
import {auditFinanceHistory} from "@/lib/payout-workers";

const source=new URL(process.env.DIRECT_DATABASE_URL??process.env.DATABASE_URL!);
const target=new URL(source);target.pathname="/"+observation.name;
const adminUrl=new URL(source);adminUrl.pathname="/postgres";
function adminSql(sql:string){execFileSync(process.env.PSQL_PATH??"psql",[adminUrl.toString(),"-q","-v","ON_ERROR_STOP=1","-c",sql],{timeout:60000,stdio:["ignore","ignore","inherit"]});}
beforeAll(async()=>{
 if(!source.pathname.endsWith("_test"))throw new Error("Disposable test database required");
 adminSql('CREATE DATABASE "'+observation.name+'"');
 for(const migration of readdirSync("prisma/migrations").filter(n=>/^\d/.test(n)).sort())
  execFileSync(process.env.PSQL_PATH??"psql",[target.toString(),"-q","-v","ON_ERROR_STOP=1","-f",path.resolve("prisma/migrations",migration,"migration.sql")],{timeout:120000,stdio:["ignore","ignore","inherit"]});
},120000);
beforeEach(async()=>{
 const tables=await prisma.$queryRaw<Array<{tablename:string}>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'`;
 await prisma.$executeRawUnsafe("TRUNCATE "+tables.map(t=>'"'+t.tablename.replaceAll('"','""')+'"').join(",")+" CASCADE");
 vi.stubEnv("CRON_SECRET","accounting-outcome-test-secret");
 observation.queries.length=0;observation.paymentRead.mockReset();observation.provider.mockReset();observation.expectedProviderFactories=0;
 observation.provider.mockImplementation(()=>{throw new Error("Accounting must not contact Stripe");});
});
afterEach(()=>{vi.unstubAllEnvs();expect(observation.provider).toHaveBeenCalledTimes(observation.expectedProviderFactories);});
afterAll(async()=>{await prisma.$disconnect();adminSql('DROP DATABASE IF EXISTS "'+observation.name+'" WITH (FORCE)');},60000);

async function fixture(mismatch?:"amount"|"currency"|"quote",paid=true){
 const id=crypto.randomUUID();
 await prisma.user.createMany({data:[{id:"customer-"+id,email:id+"@guest.test"},{id:"owner-"+id,email:id+"@host.test",role:"HOST"}]});
 await prisma.hostProfile.create({data:{id:"host-"+id,userId:"owner-"+id,legalName:"Synthetic independent host"}});
 await prisma.vehicle.create({data:{id:"vehicle-"+id,hostId:"host-"+id,slug:id,vin:id,licensePlate:id,year:2024,make:"Fixture",model:"Car",category:"SEDAN",dailyRateCents:10000,weeklyRateCents:50000,monthlyRateCents:100000}});
 const reservation=await prisma.reservation.create({data:{id,confirmationNumber:id,customerId:"customer-"+id,vehicleId:"vehicle-"+id,pickupAt:new Date("2055-01-01"),returnAt:new Date("2055-01-02"),status:"COMPLETED",financialDisposition:"OPEN",rateType:"DAILY",rateAmountCents:10000,units:1,subtotalCents:10000,totalCents:10000}});
 await prisma.financeQuote.create({data:{reservationId:id,terms:{commission:{engine:"MARKETPLACE_V1"},tax:{},settlement:{loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}},amounts:{grossCents:10000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1000,hostNetCents:9000,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:mismatch==="quote"?10001:10000},approved:false}}});
 const payment=paid?await prisma.payment.create({data:{reservationId:id,type:"RENTAL",status:"SUCCEEDED",amountCents:mismatch==="amount"?9999:10000,currency:mismatch==="currency"?"eur":"usd"}}):null;
 // Existing payout hold is evidence and must not be cleared by accounting.
 if(paid)await prisma.hostEarning.create({data:{reservationId:id,hostId:"host-"+id,grossCents:10000,commissionCents:1000,hostDiscountCents:0,netCents:9000,holdReason:"Unapproved staging payout hold"}});
 return {id,reservation,payment};
}
function inserts(){return observation.queries.length;}
async function callCron(expected:number){
 const response=await cron(new Request("https://fixture.invalid/api/cron/payouts/accounting",{method:"POST",headers:{authorization:"Bearer accounting-outcome-test-secret"}}),{params:Promise.resolve({worker:"accounting"})});
 expect(response.status).toBe(expected);
 const body=await response.json();expect(summarizeWorker(body)).toEqual(body.worker);expect(workerHttpStatus(body.worker)).toBe(expected);return body.worker;
}
async function unchanged(f:Awaited<ReturnType<typeof fixture>>){
 expect(await prisma.payment.findUnique({where:{id:f.payment!.id}})).toEqual(f.payment);
 expect(await prisma.reservation.findUnique({where:{id:f.id}})).toEqual(f.reservation);
 expect(await prisma.hostEarning.findUnique({where:{reservationId:f.id}})).toMatchObject({holdReason:"Unapproved staging payout hold",netCents:9000,refundedCents:0});
 const eligibility=await withReservationLock(f.id,tx=>payoutEligibility(tx,f.id));
 expect(eligibility.eligible).toBe(false);expect(eligibility.reasons).toContain("Financial reconciliation unresolved");
 expect(await prisma.financialOperation.count()).toBe(0);expect(await prisma.payoutBatch.count()).toBe(0);
}
it.each(["amount","currency"] as const)("persisted %s mismatch is review through real authenticated cron and replay",async kind=>{
 const f=await fixture(kind);
 expect(await prisma.financeIssue.count()).toBe(0);observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:0,processed:0,review:1,actionable:1,failed:0,skipped:0,status:"FAILED"});
 const issue=await prisma.financeIssue.findUniqueOrThrow({where:{key:"payment-mismatch:"+f.id}});
 expect(issue).toMatchObject({kind:"PAYMENT_DIFFERENCE",status:"OPEN"});
 expect(await prisma.ledgerJournal.count()).toBe(0);expect(inserts()).toBe(0);
 await unchanged(f);
 expect(summarizeWorker(await reconcileAccounting())).toMatchObject({committed:0,review:1,actionable:1,status:"FAILED"});
 expect(await callCron(503)).toMatchObject({committed:0,review:1,actionable:1,status:"FAILED"});
 expect(await prisma.financeIssue.findMany()).toEqual([issue]);expect(inserts()).toBe(0);await unchanged(f);
});
it("mixed committed/review batch reports partial failure; replay inserts nothing",async()=>{
 const good=await fixture(),bad=await fixture("amount");observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:1,review:1,failed:0,actionable:1,status:"PARTIAL_FAILURE"});
 expect(await prisma.ledgerJournal.count({where:{reservationId:good.id}})).toBe(1);
 expect(await prisma.ledgerJournal.count({where:{reservationId:bad.id}})).toBe(0);expect(inserts()).toBe(1);
 const journals=await prisma.ledgerJournal.findMany({include:{lines:true}}),issues=await prisma.financeIssue.findMany();
 observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:0,review:1,skipped:1,actionable:1,status:"FAILED"});
 expect(inserts()).toBe(0);expect(await prisma.ledgerJournal.findMany({include:{lines:true}})).toEqual(journals);
 expect(await prisma.financeIssue.findMany()).toEqual(issues);await unchanged(bad);
});
it("valid accounting is SUCCESS once, then NO_WORK; empty work is NO_WORK",async()=>{
 expect(await callCron(200)).toMatchObject({committed:0,review:0,skipped:0,status:"NO_WORK"});
 const f=await fixture();observation.queries.length=0;
 expect(await callCron(200)).toMatchObject({committed:1,review:0,failed:0,status:"SUCCESS"});expect(inserts()).toBe(1);
 observation.queries.length=0;
 expect(await callCron(200)).toMatchObject({committed:0,review:0,skipped:1,status:"NO_WORK"});expect(inserts()).toBe(0);
 expect(await prisma.ledgerJournal.count({where:{reservationId:f.id}})).toBe(1);
});
it("normal empty-reservation exit explicitly returns NO_WORK",async()=>{
 const f=await fixture(undefined,false);observation.queries.length=0;
 expect(await withReservationLock(f.id,tx=>accountReservation(tx,f.id))).toEqual({status:"NO_WORK"});
 expect(inserts()).toBe(0);
});
it("real historical-refund compatibility review never counts as committed and preserves immutable journals",async()=>{
 const f=await fixture();
 expect(await withReservationLock(f.id,tx=>accountReservation(tx,f.id))).toEqual({status:"COMMITTED"});
 const refund=await prisma.refund.create({data:{reservationId:f.id,paymentId:f.payment!.id,amountCents:5000,status:"SUCCEEDED",reason:"Historical contradictory allocation",idempotencyKey:crypto.randomUUID()}});
 await withReservationLock(f.id,tx=>journal(tx,{key:"refund:"+refund.id,kind:"REFUND",currency:"usd",reservationId:f.id,hostId:"host-"+f.id,providerId:null,description:"Historical allocation retained verbatim",lines:[{account:"HOST_PAYABLE",debitCents:4000},{account:"UNSETTLED_PLATFORM_FEES",debitCents:1000},{account:"STRIPE_CLEARING",creditCents:5000}]}));
 await prisma.hostEarning.update({where:{reservationId:f.id},data:{refundedCents:4000}});
 const original=await prisma.ledgerJournal.findMany({include:{lines:true},orderBy:{id:"asc"}});
 observation.queries.length=0;
 expect(await withReservationLock(f.id,tx=>accountReservation(tx,f.id))).toEqual({status:"REVIEW"});
 for(let replay=0;replay<2;replay++)expect(await callCron(503)).toMatchObject({committed:0,review:1,failed:0,actionable:1,status:"FAILED"});
 expect(await prisma.financeIssue.count({where:{kind:"REFUND_COMPATIBILITY_REVIEW",status:"OPEN"}})).toBe(1);
 expect(await prisma.refundCompatibilityEvidence.count()).toBe(0);
 expect(await prisma.ledgerJournal.findMany({include:{lines:true},orderBy:{id:"asc"}})).toEqual(original);expect(inserts()).toBe(0);
 expect(await prisma.payment.findUnique({where:{id:f.payment!.id}})).toEqual(f.payment);
 expect(await prisma.reservation.findUnique({where:{id:f.id}})).toEqual(f.reservation);
 expect(await prisma.hostEarning.findUnique({where:{reservationId:f.id}})).toMatchObject({holdReason:"Unapproved staging payout hold",refundedCents:4000});
 expect((await withReservationLock(f.id,tx=>payoutEligibility(tx,f.id))).eligible).toBe(false);
});
it("unauthenticated accounting cron does not run accounting",async()=>{
 await fixture();observation.queries.length=0;
 const response=await cron(new Request("https://fixture.invalid/api/cron/payouts/accounting",{method:"POST"}),{params:Promise.resolve({worker:"accounting"})});
 expect(response.status).toBe(401);expect(await prisma.ledgerJournal.count()).toBe(0);expect(inserts()).toBe(0);
});
it("normal completion with an unmatched refund remains REVIEW",async()=>{
 const f=await fixture(),other=await prisma.payment.create({data:{reservationId:f.id,type:"ADDITIONAL_CHARGE",status:"SUCCEEDED",amountCents:1000}});
 await prisma.refund.create({data:{reservationId:f.id,paymentId:other.id,amountCents:500,status:"SUCCEEDED",reason:"No matching rental allocation",idempotencyKey:crypto.randomUUID()}});
 observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:0,review:1,failed:0,actionable:1,status:"FAILED"});
 expect(inserts()).toBe(2); // Rental + additional collection retained; neither completes this reservation.
 expect(await prisma.ledgerJournal.count({where:{kind:"REFUND"}})).toBe(0);
 expect(await prisma.financeIssue.count({where:{kind:"REFUND_DIFFERENCE",status:"OPEN"}})).toBe(1);
 observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:0,review:1,status:"FAILED"});expect(inserts()).toBe(0);
});
it("transaction failure is failed rather than review or committed, and remains actionable on replay",async()=>{
 const f=await fixture("quote");
 observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:0,review:0,failed:1,actionable:1,status:"FAILED"});
 expect(inserts()).toBe(0);expect(await prisma.ledgerJournal.count()).toBe(0);
 expect(await prisma.financeIssue.count({where:{kind:"ACCOUNTING_REVIEW",status:"OPEN"}})).toBe(1);
 expect(await callCron(503)).toMatchObject({committed:0,review:0,failed:1,actionable:1,status:"FAILED"});
 expect(inserts()).toBe(0);await unchanged(f);
});
it("historical provider audit propagates real accounting REVIEW",async()=>{
 const f=await fixture("amount"),providerId="pi_"+f.id;
 await prisma.payment.update({where:{id:f.payment!.id},data:{stripePaymentIntentId:providerId}});
 const retrieve=vi.fn(async()=>({id:providerId,amount:9999,currency:"usd",status:"succeeded",latest_charge:{balance_transaction:{id:"txn_"+f.id,amount:9999,fee:300,net:9699,currency:"usd"}}}));
 observation.expectedProviderFactories=1;observation.provider.mockReturnValue({paymentIntents:{retrieve}});
 observation.queries.length=0;
 expect(summarizeWorker(await auditFinanceHistory())).toMatchObject({committed:0,review:1,failed:0,actionable:1,status:"FAILED"});
 expect(retrieve).toHaveBeenCalledTimes(1);expect(inserts()).toBe(0);
 expect(await prisma.financeIssue.count({where:{kind:"PAYMENT_DIFFERENCE",status:"OPEN"}})).toBe(1);
 expect(await prisma.providerFeeEvidence.count()).toBe(1);
 expect(await prisma.financialOperation.count()).toBe(0);
});

async function legacySuspense() {
 const f=await fixture(undefined,false);
 await prisma.vehicle.update({where:{id:f.reservation.vehicleId},data:{hostId:null}});
 await prisma.financeQuote.delete({where:{reservationId:f.id}});
 const payment=await prisma.payment.create({data:{reservationId:f.id,type:"RENTAL",status:"SUCCEEDED",amountCents:10000}});
 const refund=await prisma.refund.create({data:{reservationId:f.id,paymentId:payment.id,amountCents:1000,status:"SUCCEEDED",reason:"Synthetic legacy refund",idempotencyKey:crypto.randomUUID()}});
 return {...f,payment,refund};
}
async function retainedState(id:string) {
 return {
  journals:await prisma.ledgerJournal.findMany({where:{reservationId:id},include:{lines:{orderBy:{id:"asc"}}},orderBy:{id:"asc"}}),
  issues:await prisma.financeIssue.findMany({where:{reservationId:id},orderBy:{id:"asc"}}),
  snapshot:await prisma.financeSnapshot.findUnique({where:{reservationId:id}}),
 };
}
async function heldLegacy(f:Awaited<ReturnType<typeof legacySuspense>>) {
 expect(await prisma.reservation.findUnique({where:{id:f.id}})).toEqual(f.reservation);
 expect(await prisma.payment.findUnique({where:{id:f.payment.id}})).toEqual(f.payment);
 expect(await prisma.refund.findUnique({where:{id:f.refund.id}})).toEqual(f.refund);
 expect(await prisma.hostEarning.count()).toBe(0);
 expect(await prisma.payoutBatch.count()).toBe(0);
 expect(await prisma.financialOperation.count()).toBe(0);
 const eligible=await withReservationLock(f.id,tx=>payoutEligibility(tx,f.id));
 expect(eligible.eligible).toBe(false);
 expect(eligible.reasons).toContain("Financial reconciliation unresolved");
}
it("legacy no-host suspense stays actionable on every replay and cannot be written off",async()=>{
 const f=await legacySuspense();
 const expected={committed:0,processed:0,review:1,actionable:1,failed:0,skipped:0,status:"FAILED"};
 expect(await callCron(503)).toMatchObject(expected);
 const retained=await retainedState(f.id);
 expect(retained.journals).toHaveLength(2);expect(inserts()).toBe(2);
 expect(retained.journals.flatMap(j=>j.lines).filter(l=>l.account==="REFUND_SUSPENSE")).toMatchObject([{debitCents:1000,creditCents:0}]);
 expect(retained.issues).toMatchObject([{kind:"ALLOCATION_REQUIRED",status:"OPEN"}]);
 const checkpoint=await prisma.accountingCheckpoint.findUniqueOrThrow({where:{reservationId:f.id}});
 expect(checkpoint.fingerprint).toBe("INCOMPLETE");
 const admin=await prisma.user.create({data:{email:"allocation-admin@test.invalid",role:"SUPER_ADMIN"}});
 await expect(resolveFinanceIssue(admin.id,retained.issues[0].id,"123456","Approve the legacy suspense allocation")).rejects.toThrow("cannot be written off");
 observation.queries.length=0;
 for(let replay=0;replay<3;replay++) {
  expect(await callCron(503)).toMatchObject(expected);
  expect(await retainedState(f.id)).toEqual(retained);expect(inserts()).toBe(0);
  expect(await prisma.accountingCheckpoint.count()).toBe(1);
  expect(await prisma.accountingCheckpoint.findUnique({where:{reservationId:f.id}})).toMatchObject({reservationId:checkpoint.reservationId,fingerprint:"INCOMPLETE",version:checkpoint.version+replay+1});
  await heldLegacy(f);
 }
});
it("certification-only incomplete evidence without a FinanceIssue remains selected",async()=>{
 const f=await fixture(undefined,false);
 await prisma.vehicle.update({where:{id:f.reservation.vehicleId},data:{hostId:null}});
 const payment=await prisma.payment.create({data:{reservationId:f.id,type:"RENTAL",status:"PROCESSING",amountCents:10000,stripePaymentIntentId:"pi_certification_"+f.id}});
 await withReservationLock(f.id,tx=>certifyAccounting(tx,f.id));
 expect(await prisma.financeIssue.count()).toBe(0);
 for(let replay=0;replay<2;replay++) {
  expect(await callCron(503)).toMatchObject({committed:0,review:1,actionable:1,failed:0,status:"FAILED"});
  expect(await prisma.accountingCheckpoint.count()).toBe(1);
  expect(await prisma.accountingCheckpoint.findUnique({where:{reservationId:f.id}})).toMatchObject({fingerprint:"INCOMPLETE"});
  expect(await prisma.financeIssue.count()).toBe(0);expect(inserts()).toBe(0);
 }
 // Out-of-batch incomplete checkpoints are also counted, without a kind list.
 expect(summarizeWorker(await reconcileAccounting(0))).toMatchObject({review:1,actionable:1,status:"FAILED"});
 // Provider boundary only: the actual failed-intent handler verifies the current
 // provider result, then projects it under the reservation lock.
 const declined={id:payment.stripePaymentIntentId,status:"requires_payment_method"} as Stripe.PaymentIntent;
 observation.paymentRead.mockResolvedValue(declined);
 await handlePaymentIntentFailed(declined);expect(observation.paymentRead).toHaveBeenCalledTimes(1);
 for(let replay=0;replay<2;replay++)expect(await callCron(200)).toMatchObject({committed:0,review:0,actionable:0,failed:0,skipped:1,status:"NO_WORK"});
 expect(await prisma.accountingCheckpoint.count()).toBe(1);
 expect((await prisma.accountingCheckpoint.findUniqueOrThrow({where:{reservationId:f.id}})).fingerprint).not.toBe("INCOMPLETE");
 expect(await prisma.financeIssue.count()).toBe(0);expect(inserts()).toBe(0);
 expect(await prisma.reservation.findUnique({where:{id:f.id}})).toEqual(f.reservation);
});
it("new committed work and a retained incomplete review are counted once each",async()=>{
 const held=await legacySuspense();await callCron(503);
 const retained=await retainedState(held.id),good=await fixture();observation.queries.length=0;
 expect(await callCron(503)).toMatchObject({committed:1,review:1,failed:0,actionable:1,status:"PARTIAL_FAILURE"});
 expect(inserts()).toBe(1);expect(await retainedState(held.id)).toEqual(retained);
 expect(await prisma.ledgerJournal.count({where:{reservationId:good.id}})).toBe(1);
 expect(await prisma.accountingCheckpoint.count()).toBe(2);
});
it("two independent worker connections discover the same incomplete reservation before either projects",async()=>{
 const f=await legacySuspense();await callCron(503);const retained=await retainedState(f.id);
 const url=new URL(target);url.searchParams.set("connection_limit","1");
 const clients=[new PrismaClient({datasources:{db:{url:url.toString()}}}),new PrismaClient({datasources:{db:{url:url.toString()}}})];
 let arrived=0;let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const discovered:string[][]=[];
 try {
  const pids=await Promise.all(clients.map(db=>db.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`));
  expect(new Set(pids.map(x=>x[0].pid)).size).toBe(2);
  const workers=clients.map(db=>db.$extends({query:{$allOperations:async({operation,args,query})=>{
   const result=await query(args);
   if(operation==="$queryRaw"&&JSON.stringify(args).includes("SELECT r.id FROM")) {
    discovered.push((result as Array<{id:string}>).map(r=>r.id));
    if(++arrived===2)release();await barrier;
   }
   return result;
  }}}));
  const results=await Promise.all(workers.map(db=>reconcileAccounting(25,db as unknown as PrismaClient)));
  expect(discovered).toEqual([[f.id],[f.id]]);
  for(const result of results)expect(summarizeWorker(result)).toMatchObject({committed:0,review:1,failed:0,actionable:1,status:"FAILED"});
  expect(await retainedState(f.id)).toEqual(retained);
  expect(await prisma.accountingCheckpoint.count()).toBe(1);
  await heldLegacy(f);
 } finally { release();await Promise.all(clients.map(db=>db.$disconnect())); }
});

it.each(["ACCOUNTING_INCOMPLETE","POST_PAYOUT_REFUND","FUTURE_ACCOUNTING_REVIEW"])("unresolved %s cannot disappear through an issue-kind allowlist",async kind=>{
 const f=await fixture(undefined,false);
 await prisma.payment.create({data:{reservationId:f.id,type:"RENTAL",status:"PROCESSING",amountCents:10000}});
 const issue=await prisma.financeIssue.create({data:{key:"durable:"+f.id,reservationId:f.id,kind,reason:"Retained accounting review evidence"}});
 for(let replay=0;replay<2;replay++)expect(await callCron(503)).toMatchObject({committed:0,review:1,actionable:1,failed:0,status:"FAILED"});
 expect(summarizeWorker(await reconcileAccounting(0))).toMatchObject({review:1,actionable:1,status:"FAILED"});
 expect(await prisma.financeIssue.findMany()).toEqual([issue]);expect(inserts()).toBe(0);
 expect(await prisma.accountingCheckpoint.count()).toBe(1);
});

it("failed projections rotate without hiding their review or starving new work",async()=>{
 const broken=await fixture("quote");
 expect(summarizeWorker(await reconcileAccounting(1))).toMatchObject({committed:0,failed:1,review:0,actionable:1});
 const good=await fixture();
 expect(summarizeWorker(await reconcileAccounting(1))).toMatchObject({committed:1,failed:0,review:1,actionable:1,status:"PARTIAL_FAILURE"});
 expect(await prisma.ledgerJournal.count({where:{reservationId:good.id}})).toBe(1);
 expect(await prisma.ledgerJournal.count({where:{reservationId:broken.id}})).toBe(0);
 expect(await prisma.financeIssue.count({where:{reservationId:broken.id,kind:"ACCOUNTING_REVIEW",status:"OPEN"}})).toBe(1);
});
