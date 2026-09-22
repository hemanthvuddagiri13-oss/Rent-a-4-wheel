import { workerResult } from "@/lib/worker-result";
import type { Prisma } from "@prisma/client";
import { fingerprint,json } from "@/lib/financial-operations";
import { freezeFinance,roundBps,type FinanceTerms,lossSchema } from "@/lib/finance-rules";
import { lockReservation } from "@/lib/financial-locks";
import { prisma } from "@/lib/prisma";
import { certifyAccounting } from "@/lib/finance-completeness";
import { transferMayHaveMoved } from "@/lib/payout-movement";
import { additionalMarketplaceRefund } from "@/lib/marketplace-refund-allocation";
import { projectProcessingFees } from "@/lib/processing-fees";
import {ensureRefundCompatibility} from "@/lib/refund-compatibility";

export type LedgerPosting={account:string;debitCents?:number;creditCents?:number};
export async function journal(tx:Prisma.TransactionClient,input:{key:string;kind:string;currency:string;reservationId?:string|null;hostId?:string|null;operationId?:string|null;providerId?:string|null;reversalOf?:string;description:string;allocationEvidence?:Prisma.InputJsonValue;lines:LedgerPosting[]}) {
 const lines=input.lines.filter(l=>(l.debitCents??0)+(l.creditCents??0)>0).map(l=>({account:l.account,debitCents:l.debitCents??0,creditCents:l.creditCents??0}));
 if(lines.length<2||lines.some(l=>!Number.isSafeInteger(l.debitCents)||!Number.isSafeInteger(l.creditCents)||l.debitCents<0||l.creditCents<0||l.debitCents&&l.creditCents)||lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)!==0)throw new Error("Unbalanced journal");
 await tx.$queryRaw`SELECT financial_guard_xact(${"journal:"+input.key})`;
 const hash=fingerprint({...input,lines}),prior=await tx.ledgerJournal.findUnique({where:{key:input.key}});
 if(prior){if(prior.fingerprint!==hash)throw new Error("Journal idempotency mismatch");return prior;}
 const {lines:_lines,...header}=input;void _lines;
 return tx.ledgerJournal.create({data:{...header,fingerprint:hash,lines:{create:lines}}});
}
export async function reverseJournal(tx:Prisma.TransactionClient,id:string,key:string,reason:string){const j=await tx.ledgerJournal.findUniqueOrThrow({where:{id},include:{lines:true}});return journal(tx,{key,kind:"REVERSAL",currency:j.currency,reservationId:j.reservationId,hostId:j.hostId,description:reason,reversalOf:id,lines:j.lines.map(l=>({account:l.account,debitCents:l.creditCents,creditCents:l.debitCents}))});}
export async function financeIssue(tx:Prisma.TransactionClient,input:{key:string;kind:string;reason:string;reservationId?:string;hostId?:string;operationId?:string;evidence?:Prisma.InputJsonValue}){return tx.financeIssue.upsert({where:{key:input.key},create:input,update:{reason:input.reason,evidence:input.evidence,status:"OPEN",resolution:null,resolvedById:null}});}

// Caller holds the approved reservation lock. No provider calls occur here.
export async function accountReservation(tx:Prisma.TransactionClient,id:string){
 const r=await tx.reservation.findUniqueOrThrow({where:{id},include:{payments:true,refunds:true,deposit:true,trip:true}}),s=await freezeFinance(tx,id),a=s.amounts as FinanceTerms["amounts"];
 const rentals=r.payments.filter(p=>p.type==="RENTAL"&&p.status==="SUCCEEDED");
 if(rentals.length>1||rentals.some(p=>p.amountCents!==r.totalCents||p.currency!==s.currency)){await financeIssue(tx,{key:"payment-mismatch:"+id,kind:"PAYMENT_DIFFERENCE",reservationId:id,hostId:s.hostId??undefined,reason:"Rental amount or currency differs from frozen checkout evidence"});return;}
 for(const p of rentals){
  const marketplace=(s.commission as {engine?:string}).engine==="MARKETPLACE_V1";
  const lines:LedgerPosting[]=marketplace?[
   {account:"STRIPE_CLEARING",debitCents:p.amountCents},
   {account:"PLATFORM_DISCOUNTS",debitCents:a.platformDiscountCents},
   {account:"PAYMENT_PROCESSING_EXPENSE",debitCents:a.platformProcessingCents??0},
   {account:"HOST_PAYABLE",creditCents:a.hostNetCents},
   // Sample, unsettled marketplace fees are deferred, never recognized revenue.
   {account:"UNSETTLED_PLATFORM_FEES",creditCents:a.commissionCents+(a.guestServiceCents??0)},
   {account:"TAX_PAYABLE",creditCents:a.rentalTaxCents+a.feeTaxCents},
   {account:"PROTECTION_PAYABLE",creditCents:a.protectionCents??0},
   {account:"PROCESSING_PAYABLE",creditCents:(a.guestProcessingCents??0)+(a.hostProcessingCents??0)+(a.platformProcessingCents??0)},
   {account:"HOST_RISK_RESERVE_PAYABLE",creditCents:a.riskReserveCents??0},
  ]:[{account:"STRIPE_CLEARING",debitCents:p.amountCents},{account:"PLATFORM_DISCOUNTS",debitCents:a.platformDiscountCents},{account:s.hostId?"HOST_PAYABLE":"PLATFORM_RENTAL_REVENUE",creditCents:a.hostNetCents},{account:"COMMISSION_REVENUE",creditCents:a.commissionCents},{account:"TAX_PAYABLE",creditCents:a.rentalTaxCents+a.feeTaxCents},{account:"SERVICE_FEE_REVENUE",creditCents:a.feesCents}];
  await journal(tx,{key:"payment:"+p.id,kind:"RENTAL_PAYMENT",currency:p.currency,reservationId:id,hostId:s.hostId,providerId:p.stripePaymentIntentId,description:"Customer rental payment and frozen allocation",lines});
  if(s.hostId)await tx.hostEarning.upsert({where:{reservationId:id},update:{},create:{reservationId:id,hostId:s.hostId,currency:p.currency,grossCents:a.grossCents,commissionCents:a.commissionCents,hostDiscountCents:a.hostDiscountCents,netCents:a.hostNetCents,availableAt:r.trip?.endedAt?new Date(r.trip.endedAt.getTime()+Number((s.settlement as {delayDays?:number}).delayDays??365)*86400000):null}});
 }
 for(const p of r.payments.filter(p=>p.status==="SUCCEEDED"&&["ADDITIONAL_CHARGE","DEPOSIT_CAPTURE"].includes(p.type)&&p.amountCents>0)){
  await journal(tx,{key:"payment:"+p.id,kind:p.type,currency:p.currency,reservationId:id,hostId:s.hostId,providerId:p.stripePaymentIntentId,description:"Confirmed collection retained pending approved settlement allocation",lines:[{account:"STRIPE_CLEARING",debitCents:p.amountCents},{account:p.type==="DEPOSIT_CAPTURE"?"DEPOSIT_SETTLEMENT_LIABILITY":"ADDITIONAL_CHARGE_LIABILITY",creditCents:p.amountCents}]});
 }
 const earning=await tx.hostEarning.findUnique({where:{reservationId:id}}),allocation=lossSchema.safeParse((s.settlement as {loss?:unknown}).loss);
 if(!(await ensureRefundCompatibility(tx,id)).valid){await certifyAccounting(tx,id);return earning;}
 for(const f of r.refunds.filter(f=>f.status==="SUCCEEDED").sort((x,y)=>x.createdAt.getTime()-y.createdAt.getTime()||x.id.localeCompare(y.id))){
  if(await tx.ledgerJournal.findUnique({where:{key:"refund:"+f.id}}))continue;
  const paid=rentals.find(p=>p.id===f.paymentId);if(!paid){await financeIssue(tx,{key:"refund-unmatched:"+f.id,kind:"REFUND_DIFFERENCE",reservationId:id,reason:"Refund lacks succeeded rental evidence"});continue;}
  if(!allocation.success){await journal(tx,{key:"refund:"+f.id,kind:"REFUND",currency:paid.currency,reservationId:id,hostId:s.hostId,providerId:f.stripeRefundId,description:"Refund recorded pending approved loss allocation",lines:[{account:"REFUND_SUSPENSE",debitCents:f.amountCents},{account:"STRIPE_CLEARING",creditCents:f.amountCents}]});await financeIssue(tx,{key:"refund-allocation:"+f.id,kind:"ALLOCATION_REQUIRED",reservationId:id,hostId:s.hostId??undefined,reason:"Business-approved refund allocation required"});continue;}
  const priorRefunds=await tx.ledgerJournal.findMany({where:{reservationId:id,kind:"REFUND"},include:{lines:true}});
  const priorCash=priorRefunds.flatMap(j=>j.lines).filter(l=>l.account==="STRIPE_CLEARING").reduce((sum,l)=>sum+l.creditCents,0);
  const priorTax=priorRefunds.flatMap(j=>j.lines).filter(l=>l.account==="TAX_PAYABLE").reduce((sum,l)=>sum+l.debitCents,0);
  const cumulative=Math.min(paid.amountCents,priorCash+f.amountCents);
  const prorate=(amount:number)=>Number(BigInt(cumulative)*BigInt(amount)/BigInt(paid.amountCents));
  const tax=Math.min(f.amountCents,Math.max(0,prorate(a.rentalTaxCents+a.feeTaxCents)-priorTax));
  const host=Math.min(f.amountCents-tax,earning?Math.max(0,earning.netCents-earning.refundedCents+earning.adjustmentCents):0,Math.max(0,roundBps(prorate(a.hostNetCents),allocation.data.refundHostBps)-(earning?.refundedCents??0)));
  const batchItem=earning?await tx.payoutItem.findFirst({where:{earningId:earning.id,active:true}}):null;
  const batch=batchItem?await tx.payoutBatch.findUniqueOrThrow({where:{id:batchItem.batchId}}):null;
  const sent=batch?await transferMayHaveMoved(tx,batch.id):false;
  if((s.commission as {engine?:string}).engine==="MARKETPLACE_V1"){
   const previous=(accounts:string[])=>priorRefunds.flatMap(j=>j.lines).filter(l=>accounts.includes(l.account)).reduce((n,l)=>n+l.debitCents-l.creditCents,0);
   const prior={tax:previous(["TAX_PAYABLE"]),protection:previous(["PROTECTION_PAYABLE"]),reserve:previous(["HOST_RISK_RESERVE_PAYABLE"]),host:previous(["HOST_PAYABLE","HOST_RECEIVABLE"]),platformFees:previous(["UNSETTLED_PLATFORM_FEES"]),platformCost:previous(["PLATFORM_REFUND_COST"]),discount:-previous(["PLATFORM_DISCOUNTS"])};
   const availableHost=earning?Math.max(0,earning.netCents+earning.adjustmentCents-earning.refundedCents):0;
   const delta=additionalMarketplaceRefund(a,cumulative,paid.amountCents,allocation.data.refundHostBps,prior,availableHost);
   const allocationLines:LedgerPosting[]=[
    {account:"TAX_PAYABLE",debitCents:delta.tax},
    {account:"PROTECTION_PAYABLE",debitCents:delta.protection},
    {account:"HOST_RISK_RESERVE_PAYABLE",debitCents:delta.reserve},
    {account:sent?"HOST_RECEIVABLE":"HOST_PAYABLE",debitCents:delta.host},
    {account:"UNSETTLED_PLATFORM_FEES",debitCents:delta.platformFees},
    {account:"PLATFORM_REFUND_COST",debitCents:delta.platformCost},
    {account:"PLATFORM_DISCOUNTS",creditCents:delta.discount},
    {account:"STRIPE_CLEARING",creditCents:f.amountCents},
   ];
   await journal(tx,{key:"refund:"+f.id,kind:"REFUND",currency:paid.currency,reservationId:id,hostId:s.hostId,providerId:f.stripeRefundId,description:"Refund allocated from frozen marketplace policy and pass-through liabilities",allocationEvidence:json({version:1,snapshotHash:s.contentHash,refundId:f.id,paymentId:paid.id,cumulative,prior,availableHost,delta}),lines:allocationLines});
   const hostDelta=delta.host;
   if(earning&&hostDelta){await tx.hostEarning.update({where:{id:earning.id},data:{refundedCents:{increment:hostDelta}}});earning.refundedCents+=hostDelta;}
   if(batch&&hostDelta)await financeIssue(tx,{key:"refund-recovery:"+f.id,kind:sent?"POST_PAYOUT_REFUND":"BATCH_CHANGED",reservationId:id,hostId:s.hostId??undefined,reason:"Frozen marketplace refund changes batch entitlement; reconcile before movement",evidence:json({batchId:batch.id,refundId:f.id,hostCents:hostDelta,reverseTransfers:allocation.data.reverseTransfers})});
   continue;
  }
  await journal(tx,{key:"refund:"+f.id,kind:"REFUND",currency:paid.currency,reservationId:id,hostId:s.hostId,providerId:f.stripeRefundId,description:sent?"Refund after host transfer; receivable requires recovery":"Refund reduces pending host earnings",lines:[{account:sent?"HOST_RECEIVABLE":"HOST_PAYABLE",debitCents:host},{account:"TAX_PAYABLE",debitCents:tax},{account:"PLATFORM_REFUND_COST",debitCents:f.amountCents-tax-host},{account:"STRIPE_CLEARING",creditCents:f.amountCents}]});
  if(earning&&host){await tx.hostEarning.update({where:{id:earning.id},data:{refundedCents:{increment:host}}});earning.refundedCents+=host;}
  if(batch&&host)await financeIssue(tx,{key:"refund-recovery:"+f.id,kind:sent?"POST_PAYOUT_REFUND":"BATCH_CHANGED",reservationId:id,hostId:s.hostId??undefined,reason:sent?"Recover approved host share without double recovery":"Refund changed frozen batch; reconcile before movement",evidence:json({batchId:batch.id,refundId:f.id,hostCents:host,reverseTransfers:allocation.data.reverseTransfers})});
 }
 const d=r.deposit;
 if(d?.stripePaymentIntentId){
  const key="deposit-auth:"+d.stripePaymentIntentId;
  if(d.status==="SUCCEEDED"&&d.amountCents>0)await journal(tx,{key,kind:"DEPOSIT_AUTHORIZATION",currency:d.currency,reservationId:id,providerId:d.stripePaymentIntentId,description:"Off-balance-sheet security authorization, not earnings",lines:[{account:"MEMO_DEPOSIT_CONTROL",debitCents:d.amountCents},{account:"MEMO_DEPOSIT_AUTHORIZED",creditCents:d.amountCents}]});
  if(d.releasedAt||d.stripeStatus==="canceled"){const original=await tx.ledgerJournal.findUnique({where:{key}});if(original)await reverseJournal(tx,original.id,"deposit-release:"+d.stripePaymentIntentId,"Security authorization released");}
 }
 // Older generations remain evidence even after SecurityDeposit points to a
 // newer card/authorization. Releasing generation N never erases its memo entry.
 const generations=await tx.financialOperation.findMany({where:{reservationId:id,kind:"DEPOSIT",providerId:{not:null}},include:{dispatches:{where:{phase:"SUCCEEDED"}}}});
 for(const op of generations){
  const target=op.providerId!,payload=op.payload as {amount?:number;currency?:string},amount=payload.amount??0;
  const authorized=(op.result as {status?:string}|null)?.status==="requires_capture"||op.dispatches.some(x=>(x.result as {status?:string}|null)?.status==="requires_capture");
  if(!authorized||amount<=0)continue;
  const key="deposit-auth:"+target;
  if(!await tx.ledgerJournal.findUnique({where:{key}}))await journal(tx,{key,kind:"DEPOSIT_AUTHORIZATION",currency:payload.currency??"usd",reservationId:id,operationId:op.id,providerId:target,description:"Off-balance-sheet deposit generation authorization",lines:[{account:"MEMO_DEPOSIT_CONTROL",debitCents:amount},{account:"MEMO_DEPOSIT_AUTHORIZED",creditCents:amount}]});
  const release=await tx.financialOperation.findFirst({where:{reservationId:id,kind:"DEPOSIT_RELEASE",providerId:target,state:"OBSERVED",result:{path:["status"],equals:"canceled"}}});
  if(release){const original=await tx.ledgerJournal.findUniqueOrThrow({where:{key}});if(!await tx.ledgerJournal.findUnique({where:{key:"deposit-release:"+target}}))await reverseJournal(tx,original.id,"deposit-release:"+target,"Security authorization released");}
 }
 await projectProcessingFees(tx,id);
 await certifyAccounting(tx,id);
 return earning;
}
export async function reconcileAccounting(limit=25){
 const rows=await prisma.$queryRaw<Array<{id:string}>>`SELECT r.id FROM "Reservation" r WHERE NOT EXISTS(SELECT 1 FROM "FinanceIssue" i WHERE i."reservationId"=r.id AND i.kind IN ('PAYMENT_DIFFERENCE','ACCOUNTING_REVIEW','REFUND_DIFFERENCE') AND i.status<>'RESOLVED') AND (EXISTS(SELECT 1 FROM "ProviderFeeEvidence" f WHERE f."reservationId"=r.id AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='stripe-fee:'||f."providerId")) OR EXISTS(SELECT 1 FROM "HostEarning" e WHERE e."reservationId"=r.id) OR EXISTS(SELECT 1 FROM "Payment" p WHERE p."reservationId"=r.id AND p.type IN ('RENTAL','ADDITIONAL_CHARGE','DEPOSIT_CAPTURE') AND p.status='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='payment:'||p.id)) OR EXISTS(SELECT 1 FROM "Refund" f WHERE f."reservationId"=r.id AND f.status='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='refund:'||f.id)) OR EXISTS(SELECT 1 FROM "FinancialOperation" o WHERE o."reservationId"=r.id AND o.kind='DEPOSIT' AND o."providerId" IS NOT NULL AND o.result->>'status'='requires_capture' AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='deposit-auth:'||o."providerId")) OR EXISTS(SELECT 1 FROM "FinancialOperation" o WHERE o."reservationId"=r.id AND o.kind='DEPOSIT_RELEASE' AND o.state='OBSERVED' AND o.result->>'status'='canceled' AND EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='deposit-auth:'||o."providerId") AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='deposit-release:'||o."providerId"))) ORDER BY (SELECT c."updatedAt" FROM "AccountingCheckpoint" c WHERE c."reservationId"=r.id) ASC NULLS FIRST,r.id LIMIT ${limit}`;
 let processed=0,failed=0;for(const r of rows)try{await prisma.$transaction(async tx=>{await lockReservation(tx,r.id);await accountReservation(tx,r.id);},{timeout:15000});processed++;}catch{failed++;await financeIssue(prisma,{key:"accounting-error:"+r.id,kind:"ACCOUNTING_REVIEW",reservationId:r.id,reason:"Accounting projection requires investigation"});}
 return {processed,worker:workerResult({attempted:rows.length,checked:rows.length,committed:processed,failed,actionable:failed})};
}
