import type { Prisma } from "@prisma/client";
import { fingerprint,json } from "@/lib/financial-operations";
import { freezeFinance,roundBps,type FinanceTerms,lossSchema } from "@/lib/finance-rules";
import { lockReservation } from "@/lib/financial-locks";
import { prisma } from "@/lib/prisma";

export type LedgerPosting={account:string;debitCents?:number;creditCents?:number};
export async function journal(tx:Prisma.TransactionClient,input:{key:string;kind:string;currency:string;reservationId?:string|null;hostId?:string|null;operationId?:string|null;providerId?:string|null;reversalOf?:string;description:string;lines:LedgerPosting[]}) {
 const lines=input.lines.filter(l=>(l.debitCents??0)+(l.creditCents??0)>0).map(l=>({account:l.account,debitCents:l.debitCents??0,creditCents:l.creditCents??0}));
 if(lines.length<2||lines.some(l=>!Number.isSafeInteger(l.debitCents)||!Number.isSafeInteger(l.creditCents)||l.debitCents<0||l.creditCents<0||l.debitCents&&l.creditCents)||lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)!==0)throw new Error("Unbalanced journal");
 await tx.$queryRaw`SELECT financial_guard_xact(${"journal:"+input.key})`;
 const hash=fingerprint({...input,lines}),prior=await tx.ledgerJournal.findUnique({where:{key:input.key}});
 if(prior){if(prior.fingerprint!==hash)throw new Error("Journal idempotency mismatch");return prior;}
 const {lines:_lines,...header}=input;void _lines;
 return tx.ledgerJournal.create({data:{...header,fingerprint:hash,lines:{create:lines}}});
}
export async function reverseJournal(tx:Prisma.TransactionClient,id:string,key:string,reason:string){const j=await tx.ledgerJournal.findUniqueOrThrow({where:{id},include:{lines:true}});return journal(tx,{key,kind:"REVERSAL",currency:j.currency,reservationId:j.reservationId,hostId:j.hostId,description:reason,reversalOf:id,lines:j.lines.map(l=>({account:l.account,debitCents:l.creditCents,creditCents:l.debitCents}))});}
export async function financeIssue(tx:Prisma.TransactionClient,input:{key:string;kind:string;reason:string;reservationId?:string;hostId?:string;operationId?:string;evidence?:Prisma.InputJsonValue}){return tx.financeIssue.upsert({where:{key:input.key},create:input,update:{reason:input.reason,evidence:input.evidence}});}

// Caller holds the approved reservation lock. No provider calls occur here.
export async function accountReservation(tx:Prisma.TransactionClient,id:string){
 const r=await tx.reservation.findUniqueOrThrow({where:{id},include:{payments:true,refunds:true,deposit:true,trip:true}}),s=await freezeFinance(tx,id),a=s.amounts as FinanceTerms["amounts"];
 const rentals=r.payments.filter(p=>p.type==="RENTAL"&&p.status==="SUCCEEDED");
 if(rentals.length>1||rentals.some(p=>p.amountCents!==r.totalCents||p.currency!==s.currency)){await financeIssue(tx,{key:"payment-mismatch:"+id,kind:"PAYMENT_DIFFERENCE",reservationId:id,hostId:s.hostId??undefined,reason:"Rental amount or currency differs from frozen checkout evidence"});return;}
 for(const p of rentals){
  await journal(tx,{key:"payment:"+p.id,kind:"RENTAL_PAYMENT",currency:p.currency,reservationId:id,hostId:s.hostId,providerId:p.stripePaymentIntentId,description:"Customer rental payment and frozen allocation",lines:[{account:"STRIPE_CLEARING",debitCents:p.amountCents},{account:"PLATFORM_DISCOUNTS",debitCents:a.platformDiscountCents},{account:s.hostId?"HOST_PAYABLE":"PLATFORM_RENTAL_REVENUE",creditCents:a.hostNetCents},{account:"COMMISSION_REVENUE",creditCents:a.commissionCents},{account:"TAX_PAYABLE",creditCents:a.rentalTaxCents+a.feeTaxCents},{account:"SERVICE_FEE_REVENUE",creditCents:a.feesCents}]});
  if(s.hostId)await tx.hostEarning.upsert({where:{reservationId:id},update:{},create:{reservationId:id,hostId:s.hostId,currency:p.currency,grossCents:a.grossCents,commissionCents:a.commissionCents,hostDiscountCents:a.hostDiscountCents,netCents:a.hostNetCents,availableAt:r.trip?.endedAt?new Date(r.trip.endedAt.getTime()+Number((s.settlement as {delayDays?:number}).delayDays??365)*86400000):null}});
 }
 const earning=await tx.hostEarning.findUnique({where:{reservationId:id}}),allocation=lossSchema.safeParse((s.settlement as {loss?:unknown}).loss);
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
  const host=Math.min(f.amountCents-tax,earning?Math.max(0,earning.netCents-earning.refundedCents):0,Math.max(0,roundBps(prorate(a.hostNetCents),allocation.data.refundHostBps)-(earning?.refundedCents??0)));
  const batchItem=earning?await tx.payoutItem.findFirst({where:{earningId:earning.id,active:true}}):null;
  const batch=batchItem?await tx.payoutBatch.findUniqueOrThrow({where:{id:batchItem.batchId}}):null;
  const sent=Boolean(batch?.transferredCents);
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
 return earning;
}
export async function reconcileAccounting(limit=25){
 const rows=await prisma.$queryRaw<Array<{id:string}>>`SELECT r.id FROM "Reservation" r WHERE NOT EXISTS(SELECT 1 FROM "FinanceIssue" i WHERE i."reservationId"=r.id AND i.kind IN ('PAYMENT_DIFFERENCE','ACCOUNTING_REVIEW','REFUND_DIFFERENCE') AND i.status<>'RESOLVED') AND (EXISTS(SELECT 1 FROM "Payment" p WHERE p."reservationId"=r.id AND p.type='RENTAL' AND p.status='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='payment:'||p.id)) OR EXISTS(SELECT 1 FROM "Refund" f WHERE f."reservationId"=r.id AND f.status='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM "LedgerJournal" j WHERE j.key='refund:'||f.id))) ORDER BY r."updatedAt",r.id LIMIT ${limit}`;
 let processed=0;for(const r of rows)try{await prisma.$transaction(async tx=>{await lockReservation(tx,r.id);await accountReservation(tx,r.id);},{timeout:15000});processed++;}catch{await financeIssue(prisma,{key:"accounting-error:"+r.id,kind:"ACCOUNTING_REVIEW",reservationId:r.id,reason:"Accounting projection requires investigation"});}
 return {processed};
}
