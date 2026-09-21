import { afterAll, afterEach, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import * as financeProvider from "@/lib/finance-provider";
import { auditFinanceHistory } from "@/lib/payout-workers";
import bcrypt from "bcryptjs";
import { prisma, createTestCustomer, createTestHost, createTestVehicle, createTestReservation } from "./helpers/factories";
import { accountReservation,journal } from "@/lib/finance-ledger";
import { accountingCompleteness } from "@/lib/finance-completeness";
import { withReservationLock } from "@/lib/financial-locks";
import { proposeAdjustment, approveAdjustment } from "@/lib/finance-admin";
import { PrismaClient } from "@prisma/client";
import { barrier } from "./helpers/barrier";
import { retainProcessingFee } from "@/lib/processing-fees";

afterAll(() => prisma.$disconnect());
afterEach(()=>vi.restoreAllMocks());

async function fixture(funding?:"HOST"|"GUEST"|"PLATFORM", deferProjection=false) {
  const host = await createTestHost(), customer = await createTestCustomer();
  const vehicle = await createTestVehicle({hostId:host.hostProfile.id});
  const r = await createTestReservation({vehicleId:vehicle.id,customerId:customer.id,pickupAt:new Date("2045-01-01"),returnAt:new Date("2045-01-04"),status:"COMPLETED"});
  await prisma.financeQuote.create({data:{reservationId:r.id,terms:{commission:{engine:"MARKETPLACE_V1"},tax:{},settlement:{loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}},amounts:{grossCents:15000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:funding==="GUEST"?1200:1500,hostNetCents:funding==="HOST"?13200:13500,hostProcessingCents:funding==="HOST"?300:0,guestProcessingCents:funding==="GUEST"?300:0,platformProcessingCents:funding==="PLATFORM"?300:0,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:15000},approved:false}}});
  const payment = await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:15000,stripePaymentIntentId:funding?"pi_"+crypto.randomUUID():undefined}});
  const project = () => withReservationLock(r.id,tx=>accountReservation(tx,r.id));
  if(!deferProjection)await project();
  const refund = async (amountCents:number) => {
    await prisma.refund.create({data:{reservationId:r.id,paymentId:payment.id,amountCents,status:"SUCCEEDED",reason:"Correction regression",idempotencyKey:crypto.randomUUID()}});
    await project(); await project();
  };
  const prepareAdjustment = async (kind:"HOST_CREDIT"|"HOST_DEBIT",amountCents:number) => {
    const proposer = await createTestCustomer({role:"SUPER_ADMIN"}), approver = await createTestCustomer({role:"SUPER_ADMIN"});
    const evidence = await prisma.financialCase.create({data:{sourceKey:crypto.randomUUID(),reservationId:r.id,customerId:customer.id,kind:"SETTLEMENT",amountCents,currency:"usd",reason:"Correction approved settlement",status:"RESOLVED",resolution:"Approved evidence"}});
    const a = await proposeAdjustment(proposer.id,{reservationId:r.id,kind,amountCents,reason:"Correction approved settlement",evidenceId:evidence.id});
    await prisma.authCode.create({data:{email:approver.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
    return ()=>approveAdjustment(approver.id,a.id,"123456");
  };
  const adjust=async(kind:"HOST_CREDIT"|"HOST_DEBIT",amountCents:number)=>(await prepareAdjustment(kind,amountCents))();
  return {r, vehicle, payment, refund, adjust, prepareAdjustment, project};
}

it("posted host refund cannot move backward after an approved debit; full recovery remains balanced and certified",async()=>{
  const f=await fixture(); await f.refund(7500);
  const before=await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}});
  expect(before.refundedCents).toBe(6750);
  await f.adjust("HOST_DEBIT",6000);
  // Previously posted allocations remain authoritative even before another refund.
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
  await f.refund(100);
  expect((await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}})).refundedCents).toBeGreaterThanOrEqual(before.refundedCents);
  await f.refund(7400);
  const e=await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}});
  expect(e).toMatchObject({netCents:13500,adjustmentCents:-6000,refundedCents:7500});
  const journals=await prisma.ledgerJournal.findMany({where:{reservationId:f.r.id},include:{lines:true}});
  for(const j of journals)expect(j.lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)).toBe(0);
  expect(journals.filter(j=>j.kind==="REFUND")).toHaveLength(3);
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
});

it.each([false,true])("retains the fee receipt across a real projection rollback and resumes without another provider call (receipt first: %s)",async(receiptFirst)=>{
 const f=await fixture("PLATFORM",receiptFirst),id="txn_"+crypto.randomUUID();
 const balance={id,amount:15000,fee:400,net:14600,currency:"usd",source:"ch_fixture",type:"charge"} as Stripe.BalanceTransaction;
 const provider=vi.fn(async()=>balance);await retainProcessingFee(f.payment.id,await provider());
 await expect(withReservationLock(f.r.id,async tx=>{await accountReservation(tx,f.r.id);await tx.$executeRawUnsafe("SELECT 1 / 0");})).rejects.toThrow();
 expect(await prisma.providerFeeEvidence.count({where:{providerId:id}})).toBe(1);
 expect(await prisma.ledgerJournal.count({where:{key:"stripe-fee:"+id}})).toBe(0);
 await f.project();await f.project();
 expect(provider).toHaveBeenCalledTimes(1);
 expect(await prisma.ledgerJournal.count({where:{key:"stripe-fee:"+id}})).toBe(1);
 expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
 await expect(prisma.providerFeeEvidence.update({where:{providerId:id},data:{feeCents:401,netCents:14599}})).rejects.toThrow("immutable");
});

it("serializes approved adjustment and refund on separate blocked PostgreSQL connections",async()=>{
 const f=await fixture();await f.refund(7500);const approve=await f.prepareAdjustment("HOST_DEBIT",5000);
 const other=new PrismaClient(),entered=barrier(),release=barrier();
 const held=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT financial_guard_xact(${"vehicle:"+f.vehicle.id})`;entered.release();await release.wait;},{timeout:15000});
 await entered.wait;
 const adjustment=approve();
 const refund=withReservationLock(f.r.id,async tx=>{await tx.refund.create({data:{reservationId:f.r.id,paymentId:f.payment.id,amountCents:1000,status:"SUCCEEDED",reason:"Concurrent provider-confirmed refund",idempotencyKey:crypto.randomUUID()}});await accountReservation(tx,f.r.id);},other);
 const settled=Promise.allSettled([adjustment,refund]);
 try{
  let pids:number[]=[];
  for(let n=0;n<300;n++){
   const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;
   pids=[...new Set(rows.map(r=>r.pid))];if(pids.length>=2)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(pids.length).toBeGreaterThanOrEqual(2);
 }finally{release.release();await held;}
 try{
  expect((await settled).map(r=>r.status)).toEqual(["fulfilled","fulfilled"]);
  await f.refund(6500);await f.project();
  expect(await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}})).toMatchObject({refundedCents:8500,adjustmentCents:-5000});
  const journals=await prisma.ledgerJournal.findMany({where:{reservationId:f.r.id},include:{lines:true}});
  for(const j of journals)expect(j.lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)).toBe(0);
  expect(journals.filter(j=>j.kind==="REFUND")).toHaveLength(3);
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
 }finally{await other.$disconnect();}
});

it.each(["HOST","GUEST","PLATFORM"] as const)("settles %s processing accrual against actual provider fees without a second expense",async(funding)=>{
  for(const actual of [300,400,200]){
    await prisma.reservation.updateMany({data:{financialCheckedAt:new Date()}});
    const f=await fixture(funding),intentId=f.payment.stripePaymentIntentId!,balanceId="txn_"+crypto.randomUUID();
    const retrieve=vi.fn(async(id:string)=>{
      const p=await prisma.payment.findFirstOrThrow({where:{stripePaymentIntentId:id}});
      return {id,amount:p.amountCents,currency:p.currency,status:"succeeded",latest_charge:{balance_transaction:id===intentId?{id:balanceId,fee:actual,amount:15000,net:15000-actual,currency:"usd",type:"charge",source:"ch_fixture"}:null}};
    });
    const refundRetrieve=vi.fn(async(id:string)=>{
      const refund=await prisma.refund.findFirstOrThrow({where:{stripeRefundId:id},include:{payment:true}});
      return {id,amount:refund.amountCents,currency:refund.payment.currency,status:refund.status.toLowerCase()};
    });
    vi.spyOn(financeProvider,"financeStripe").mockReturnValue({paymentIntents:{retrieve},refunds:{retrieve:refundRetrieve},transfers:{retrieve:vi.fn()}} as unknown as Stripe);
    await auditFinanceHistory();await auditFinanceHistory();
    const lines=await prisma.ledgerLine.findMany({where:{journal:{reservationId:f.r.id}}});
    const balance=(account:string)=>lines.filter(l=>l.account===account).reduce((n,l)=>n+l.debitCents-l.creditCents,0);
    expect(balance("PROCESSING_PAYABLE")).toBe(0);
    expect(balance("PAYMENT_PROCESSING_EXPENSE")).toBe((funding==="PLATFORM"?300:0)+actual-300);
    expect(balance("STRIPE_FEE_EXPENSE")).toBe(0);
    expect(balance("STRIPE_CLEARING")).toBe(15000-actual);
    expect(await prisma.ledgerJournal.count({where:{key:"stripe-fee:"+balanceId}})).toBe(1);
  }
});

it("host credit is a separate compensating entry and never enlarges the original refund basis",async()=>{
  const f=await fixture(); await f.adjust("HOST_CREDIT",1000);
  await f.refund(4000);await f.refund(4000);await f.refund(7000);await f.project();
  expect(await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}})).toMatchObject({netCents:13500,adjustmentCents:1000,refundedCents:13500});
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
});

it("a credit after a realized refund shortfall cannot spend the next refund's budget twice",async()=>{
 const f=await fixture();await f.adjust("HOST_DEBIT",12000);await f.refund(7500);
 const prior=await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}});
 expect(prior.refundedCents).toBe(1500);
 await f.adjust("HOST_CREDIT",12000);await f.refund(100);await f.refund(7400);await f.project();
 const after=await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}});
 expect(after.refundedCents).toBeGreaterThanOrEqual(prior.refundedCents);
 const journals=await prisma.ledgerJournal.findMany({where:{reservationId:f.r.id},include:{lines:true}});
 for(const j of journals)expect(j.lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)).toBe(0);
 expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
});

it("retains the first fee receipt while provider availability advances, but rejects financial changes",async()=>{
 const f=await fixture("PLATFORM"),balance={id:"txn_"+crypto.randomUUID(),amount:15000,fee:300,net:14700,currency:"usd",source:"ch_fixture",type:"charge",status:"pending"} as Stripe.BalanceTransaction;
 const first=await retainProcessingFee(f.payment.id,balance);
 expect((await retainProcessingFee(f.payment.id,{...balance,status:"available"})).fingerprint).toBe(first.fingerprint);
 await expect(retainProcessingFee(f.payment.id,{...balance,fee:400,net:14600})).rejects.toThrow("PROVIDER_FEE_EVIDENCE_CHANGED");
 expect((await prisma.providerFeeEvidence.findUniqueOrThrow({where:{providerId:balance.id}})).evidence).toEqual(balance);
});
it("settles a previously posted fee with a compensating journal instead of rewriting evidence",async()=>{
 const f=await fixture("PLATFORM"),id="txn_"+crypto.randomUUID();
 const old=await withReservationLock(f.r.id,tx=>journal(tx,{key:"stripe-fee:"+id,kind:"STRIPE_FEE",currency:"usd",reservationId:f.r.id,providerId:id,description:"Historical provider fee",lines:[{account:"STRIPE_FEE_EXPENSE",debitCents:400},{account:"STRIPE_CLEARING",creditCents:400}]}));
 await retainProcessingFee(f.payment.id,{id,amount:15000,fee:400,net:14600,currency:"usd"} as Stripe.BalanceTransaction);
 await f.project();await f.project();
 expect(await prisma.ledgerJournal.findUniqueOrThrow({where:{id:old.id}})).toEqual(old);
 expect(await prisma.ledgerJournal.count({where:{key:"stripe-fee-correction:"+id}})).toBe(1);
 const lines=await prisma.ledgerLine.findMany({where:{journal:{reservationId:f.r.id}}});
 const balance=(account:string)=>lines.filter(l=>l.account===account).reduce((n,l)=>n+l.debitCents-l.creditCents,0);
 expect(balance("PROCESSING_PAYABLE")).toBe(0);expect(balance("STRIPE_FEE_EXPENSE")).toBe(0);expect(balance("PAYMENT_PROCESSING_EXPENSE")).toBe(400);expect(balance("STRIPE_CLEARING")).toBe(14600);
 expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
});
it("preserves fee expense behavior for a legacy snapshot",async()=>{
 const customer=await createTestCustomer(),v=await createTestVehicle(),r=await createTestReservation({vehicleId:v.id,customerId:customer.id,status:"COMPLETED",pickupAt:new Date("2049-01-01"),returnAt:new Date("2049-01-04")});
 const payment=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:15000}});
 await retainProcessingFee(payment.id,{id:"txn_"+crypto.randomUUID(),amount:15000,fee:400,net:14600,currency:"usd"} as Stripe.BalanceTransaction);
 for(let i=0;i<2;i++)await withReservationLock(r.id,tx=>accountReservation(tx,r.id));
 const lines=await prisma.ledgerLine.findMany({where:{journal:{reservationId:r.id}}});
 expect(lines.filter(l=>l.account==="STRIPE_FEE_EXPENSE").reduce((n,l)=>n+l.debitCents,0)).toBe(400);
 expect(lines.filter(l=>l.account==="PROCESSING_PAYABLE")).toHaveLength(0);
 expect((await withReservationLock(r.id,tx=>accountingCompleteness(tx,r.id))).complete).toBe(true);
});
