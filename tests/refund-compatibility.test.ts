import {afterAll,it,expect,vi} from "vitest";
import bcrypt from "bcryptjs";
import {prisma,createTestCustomer,createTestHost,createTestVehicle,createTestReservation} from "./helpers/factories";
import {accountReservation,journal} from "@/lib/finance-ledger";
import {withReservationLock} from "@/lib/financial-locks";
import {accountingCompleteness} from "@/lib/finance-completeness";
import {proposeAdjustment,approveAdjustment} from "@/lib/finance-admin";
import {PrismaClient,type Prisma} from "@prisma/client";
import {barrier} from "./helpers/barrier";
import {requireAccountingComplete} from "@/lib/finance-completeness";
import {ensureRefundCompatibility} from "@/lib/refund-compatibility";
import {executeRefundOperation} from "@/lib/refund-operations";

afterAll(()=>prisma.$disconnect());
async function historical(kind:"HOST_DEBIT"|"HOST_CREDIT",invalid?:"contradictory"|"missing"|"ambiguous"){
 const h=await createTestHost(),u=await createTestCustomer(),v=await createTestVehicle({hostId:h.hostProfile.id});
 const r=await createTestReservation({vehicleId:v.id,customerId:u.id,pickupAt:new Date("2051-01-01"),returnAt:new Date("2051-01-04"),status:"COMPLETED"});
 await prisma.reservation.update({where:{id:r.id},data:{totalCents:10000,subtotalCents:10000}});
 await prisma.financeQuote.create({data:{reservationId:r.id,terms:{commission:{engine:"MARKETPLACE_V1"},tax:{},settlement:{loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}},amounts:{grossCents:10000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1000,hostNetCents:9000,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:10000},approved:false}}});
 const p=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:10000}});
 await withReservationLock(r.id,tx=>accountReservation(tx,r.id));
 const proposer=await createTestCustomer({role:"SUPER_ADMIN"}),approver=await createTestCustomer({role:"SUPER_ADMIN"});
 const evidence=await prisma.financialCase.create({data:{sourceKey:crypto.randomUUID(),reservationId:r.id,customerId:u.id,kind:"SETTLEMENT",amountCents:4000,currency:"usd",reason:"Historical approved adjustment",status:"RESOLVED",resolution:"Independent evidence verified"}});
 const a=await proposeAdjustment(proposer.id,{reservationId:r.id,kind,amountCents:4000,reason:"Historical approved adjustment",evidenceId:evidence.id});
 await prisma.authCode.create({data:{email:approver.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
 await approveAdjustment(approver.id,a.id,"123456");
 if(invalid==="missing")await prisma.financialCase.update({where:{id:evidence.id},data:{status:"OPEN",resolution:null}});
 const f=await prisma.refund.create({data:{reservationId:r.id,paymentId:p.id,amountCents:5000,status:"SUCCEEDED",reason:"Historical partial refund",idempotencyKey:crypto.randomUUID()}});
 const host=(kind==="HOST_DEBIT"?2500:4500)+(invalid==="contradictory"?1:0),cost=4500-host;
 const j=await withReservationLock(r.id,async tx=>{const j=await journal(tx,{key:"refund:"+f.id,kind:"REFUND",currency:"usd",reservationId:r.id,hostId:h.hostProfile.id,providerId:null,description:"Refund allocated from frozen marketplace policy and pass-through liabilities",lines:[{account:"HOST_PAYABLE",debitCents:host},{account:"UNSETTLED_PLATFORM_FEES",debitCents:500},{account:"PLATFORM_REFUND_COST",debitCents:cost},{account:"STRIPE_CLEARING",creditCents:5000}]});await tx.hostEarning.update({where:{reservationId:r.id},data:{refundedCents:host}});return j;});
 return {r,p,f,j,host};
}
it.each(["HOST_DEBIT","HOST_CREDIT"] as const)("certifies valid historical %s allocation without rewriting its journal",async kind=>{
 const f=await historical(kind),before=await prisma.ledgerJournal.findUniqueOrThrow({where:{id:f.j.id},include:{lines:true}});
 expect(before.allocationEvidence).toBeNull();
 await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
 const result=await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id));
 expect(result.reasons).toEqual([]);expect(result.complete).toBe(true);
 expect(await prisma.ledgerJournal.findUniqueOrThrow({where:{id:f.j.id},include:{lines:true}})).toEqual(before);
 expect(await prisma.refundCompatibilityEvidence.count({where:{reservationId:f.r.id}})).toBe(1);
 let prior=f.host;
 for(const amount of [1000,4000]){
  await prisma.refund.create({data:{reservationId:f.r.id,paymentId:f.p.id,amountCents:amount,status:"SUCCEEDED",reason:"Incremental post-compatibility refund",idempotencyKey:crypto.randomUUID()}});
  for(let i=0;i<2;i++)await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
  const e=await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:f.r.id}});expect(e.refundedCents).toBeGreaterThanOrEqual(prior);prior=e.refundedCents;
  expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(true);
 }
 expect(prior).toBe(kind==="HOST_DEBIT"?5000:9000);
 const journals=await prisma.ledgerJournal.findMany({where:{reservationId:f.r.id},include:{lines:true}});for(const j of journals)expect(j.lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)).toBe(0);
 expect(journals.filter(j=>j.kind==="REFUND")).toHaveLength(3);
 const record=await prisma.refundCompatibilityEvidence.findUniqueOrThrow({where:{journalId:f.j.id}});expect(record).toMatchObject({version:1,validationResult:"VALID_HISTORICAL_V1"});
 expect((await executeRefundOperation(f.f.id,null)).status).toBe("already_terminal");
 await expect(prisma.refundCompatibilityEvidence.update({where:{journalId:f.j.id},data:{evidenceHash:"tampered"}})).rejects.toThrow("Immutable");
 expect(await prisma.ledgerJournal.findUniqueOrThrow({where:{id:f.j.id},include:{lines:true}})).toEqual(before);
});
it.each(["ambiguous","unbalanced"] as const)("refuses %s historical input even if the current database would prevent creating it",async shape=>{
 const f=await historical("HOST_DEBIT");
 // Simulate a damaged historical read without disabling immutable/balance
 // constraints in the shared database. Reconstruction and review writes are real.
 await withReservationLock(f.r.id,async tx=>{
  const original=tx.ledgerJournal.findMany.bind(tx.ledgerJournal);
  const spy=vi.spyOn(tx.ledgerJournal,"findMany").mockImplementation((async(args:Parameters<typeof original>[0])=>{
   const rows=await original(args) as Prisma.LedgerJournalGetPayload<{include:{lines:true}}>[];
   const refund=rows.find(r=>r.id===f.j.id)!;
   if(shape==="ambiguous")rows.find(r=>r.kind==="HOST_DEBIT")!.createdAt=refund.createdAt;
   else refund.lines.find(l=>l.account==="STRIPE_CLEARING")!.creditCents++;
   return rows;
  }) as typeof tx.ledgerJournal.findMany);
  try{expect((await ensureRefundCompatibility(tx,f.r.id)).valid).toBe(false);await expect(requireAccountingComplete(tx,f.r.id)).rejects.toThrow("Accounting incomplete");}finally{spy.mockRestore();}
 });
 expect(await prisma.refundCompatibilityEvidence.count({where:{reservationId:f.r.id}})).toBe(0);
 expect(await prisma.financeIssue.count({where:{reservationId:f.r.id,kind:"REFUND_COMPATIBILITY_REVIEW",status:"OPEN"}})).toBe(1);
});
it.each(["missing","contradictory"] as const)("quarantines %s historical evidence and refuses payout certification",async invalid=>{
 const f=await historical("HOST_DEBIT",invalid);
 await withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id));
 expect((await withReservationLock(f.r.id,tx=>accountingCompleteness(tx,f.r.id))).complete).toBe(false);
 await expect(withReservationLock(f.r.id,tx=>requireAccountingComplete(tx,f.r.id))).rejects.toThrow("Accounting incomplete");
 expect(await prisma.refundCompatibilityEvidence.count({where:{reservationId:f.r.id}})).toBe(0);
 expect(await prisma.financeIssue.count({where:{reservationId:f.r.id,kind:"REFUND_COMPATIBILITY_REVIEW",status:"OPEN"}})).toBe(1);
});
it("serializes simultaneous reconstruction on separate blocked database connections",async()=>{
 const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("connection_limit","1");
 const f=await historical("HOST_DEBIT"),other=new PrismaClient({datasources:{db:{url:url.toString()}}}),entered=barrier(),release=barrier();
 const [{pid}]=await other.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`;
 const held=withReservationLock(f.r.id,async tx=>{entered.release();await release.wait;await accountReservation(tx,f.r.id);});await entered.wait;
 const next=withReservationLock(f.r.id,tx=>accountReservation(tx,f.r.id),other);const settled=Promise.allSettled([held,next]);
 try{let blocked=false;for(let i=0;i<300;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;if(rows.length){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);}finally{release.release();}
 try{expect((await settled).map(r=>r.status)).toEqual(["fulfilled","fulfilled"]);expect(await prisma.refundCompatibilityEvidence.count({where:{reservationId:f.r.id}})).toBe(1);expect(await prisma.ledgerJournal.count({where:{reservationId:f.r.id,kind:"REFUND"}})).toBe(1);}finally{await other.$disconnect();}
});
