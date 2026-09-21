import type { Prisma } from "@prisma/client";
import { fingerprint } from "@/lib/financial-operations";
import { lossSchema,roundBps } from "@/lib/finance-rules";

// Call only while holding the reservation guard. This checkpoint describes
// economic evidence, not UI status or worker timestamps. New evidence makes it
// stale even when an operator has closed its review case.
async function accountingEvidence(tx: Prisma.TransactionClient, reservationId: string) {
 const payments=await tx.payment.findMany({where:{reservationId},orderBy:{id:"asc"}});
 const refunds=await tx.refund.findMany({where:{reservationId},orderBy:{id:"asc"}});
 const operations=await tx.financialOperation.findMany({where:{reservationId},include:{dispatches:{orderBy:{id:"asc"}}},orderBy:{id:"asc"}});
 const disputes=await tx.providerDispute.findMany({where:{reservationId},orderBy:{id:"asc"}});
 const adjustments=await tx.financeAdjustment.findMany({where:{reservationId,state:"APPROVED"},orderBy:{id:"asc"}});
 const journals=await tx.ledgerJournal.findMany({where:{reservationId},include:{lines:true},orderBy:{id:"asc"}});
 const earning=await tx.hostEarning.findUnique({where:{reservationId}});
 const snapshot=await tx.financeSnapshot.findUnique({where:{reservationId}});
 const reasons:string[]=[];
 const posting=(key:string)=>journals.find(j=>j.key===key);
 for(const p of payments.filter(p=>["RENTAL","ADDITIONAL_CHARGE","DEPOSIT_CAPTURE"].includes(p.type))) {
  if(["PENDING","PROCESSING"].includes(p.status))reasons.push("Payment outcome pending: "+p.id);
  if(p.status==="SUCCEEDED"){
   const j=posting("payment:"+p.id);
   if(!j||j.currency!==p.currency||j.lines.filter(l=>l.account==="STRIPE_CLEARING").reduce((n,l)=>n+l.debitCents,0)!==p.amountCents)reasons.push("Payment not accounted: "+p.id);
  }
 }
 for(const f of refunds){
  if(f.legacyUncertain||f.status==="PENDING")reasons.push("Refund outcome pending or uncertain: "+f.id);
  if(f.status==="SUCCEEDED"){
   const j=posting("refund:"+f.id),p=payments.find(p=>p.id===f.paymentId);
   if(!j||j.currency!==p?.currency||j.lines.some(l=>l.account==="REFUND_SUSPENSE")||j.lines.filter(l=>l.account==="STRIPE_CLEARING").reduce((n,l)=>n+l.creditCents,0)!==f.amountCents)reasons.push("Refund not allocated: "+f.id);
  }
 }
 for(const op of operations){
  if(["REVIEW","DEAD_LETTER"].includes(op.state))reasons.push("Provider operation quarantined: "+op.id);
  const effect=op.providerId||op.dispatches.some(d=>["DISPATCHED","SUCCEEDED","UNCERTAIN"].includes(d.phase));
  if(effect&&!['OBSERVED','POLL'].includes(op.state))reasons.push("Provider receipt not projected: "+op.id);
  const observations=[op.result,...op.dispatches.filter(d=>d.phase==="SUCCEEDED").map(d=>d.result)];
  for(const value of observations){
   const result=value as {id?:string;status?:string;amount?:number}|null;
   if(!result||result.status!=="succeeded")continue;
   if(op.kind==="RENTAL"&&!payments.some(p=>p.stripePaymentIntentId===result.id&&p.status==="SUCCEEDED"&&p.amountCents===result.amount))reasons.push("Accepted payment lacks matching projection: "+op.id);
   if(op.kind==="REFUND"&&!refunds.some(f=>f.stripeRefundId===result.id&&f.status==="SUCCEEDED"&&f.amountCents===result.amount))reasons.push("Accepted refund lacks matching projection: "+op.id);
  }
 }
 for(const d of disputes){
  if(d.active)reasons.push("Provider dispute unresolved: "+d.id);
  if(d.status==="lost"&&(!posting("chargeback:"+d.id)||!posting("chargeback-allocation:"+d.id)))reasons.push("Chargeback allocation incomplete: "+d.id);
 }
 for(const a of adjustments)if(!a.journalId||posting("adjustment:"+a.id)?.id!==a.journalId)reasons.push("Approved adjustment not accounted: "+a.id);
 const lines=journals.flatMap(j=>j.lines.map(l=>({...l,kind:j.kind})));
 const refunded=lines.filter(l=>l.kind==="REFUND"&&["HOST_PAYABLE","HOST_RECEIVABLE"].includes(l.account)).reduce((n,l)=>n+l.debitCents-l.creditCents,0);
 const adjusted=lines.filter(l=>["HOST_CREDIT","HOST_DEBIT","CLAIM_ADJUSTMENT","ADDITIONAL_CHARGE_ALLOCATION","CHARGEBACK_ALLOCATION"].includes(l.kind)&&["HOST_PAYABLE","HOST_RECEIVABLE"].includes(l.account)).reduce((n,l)=>n+l.creditCents-l.debitCents,0);
 const net=(snapshot?.amounts as {hostNetCents?:number}|undefined)?.hostNetCents;
 const rental=payments.filter(p=>p.type==="RENTAL"&&p.status==="SUCCEEDED");
 const allocation=lossSchema.safeParse((snapshot?.settlement as {loss?:unknown}|undefined)?.loss);
 if(rental.length===1&&net!==undefined&&allocation.success){
  const paid=rental[0],cash=refunds.filter(f=>f.paymentId===paid.id&&f.status==="SUCCEEDED").reduce((n,f)=>n+f.amountCents,0);
  const amounts=snapshot!.amounts as {rentalTaxCents:number;feeTaxCents:number};
  if(paid.amountCents<=0||cash>paid.amountCents)reasons.push("Refund total exceeds captured rental evidence");
  else{
   const prorate=(amount:number)=>Number(BigInt(cash)*BigInt(amount)/BigInt(paid.amountCents));
   const expected=Math.min(cash-prorate(amounts.rentalTaxCents+amounts.feeTaxCents),Math.max(0,net+adjusted),roundBps(prorate(net),allocation.data.refundHostBps));
   if(refunded!==expected)reasons.push("Refund allocation differs from frozen policy entitlement");
  }
 }
 if(earning&&(earning.netCents!==net||earning.refundedCents!==refunded||earning.adjustmentCents!==adjusted))reasons.push("Earnings differ from immutable accounting journals");
 if(!earning&&payments.some(p=>p.type==="RENTAL"&&p.status==="SUCCEEDED")&&snapshot?.hostId)reasons.push("Host earning projection missing");
 const hash=fingerprint({version:1,snapshot:snapshot?.contentHash,payments:payments.map(p=>[p.id,p.type,p.status,p.amountCents,p.currency,p.stripePaymentIntentId]),refunds:refunds.map(f=>[f.id,f.paymentId,f.status,f.amountCents,f.stripeRefundId,f.legacyUncertain]),operations:operations.map(o=>[o.id,o.fingerprint,o.providerId,o.result,o.dispatches.map(d=>[d.id,d.phase,d.providerId,d.result])]),disputes:disputes.map(d=>[d.id,d.status,d.amountCents,d.currency,d.active]),adjustments:adjustments.map(a=>[a.id,a.kind,a.amountCents,a.journalId]),journals:journals.map(j=>[j.id,j.fingerprint]),earning:earning?[earning.netCents,earning.refundedCents,earning.adjustmentCents]:null});
 return {hash,reasons,amountCents:earning?earning.netCents-earning.refundedCents+earning.adjustmentCents:0};
}

export async function certifyAccounting(tx:Prisma.TransactionClient,reservationId:string){
 const evidence=await accountingEvidence(tx,reservationId);
 // A failed checkpoint remains unmistakably non-authoritative, but rotates in
 // accounting recovery so pending provider work cannot starve other bookings.
 const hash=evidence.reasons.length?"INCOMPLETE":evidence.hash;
 await tx.accountingCheckpoint.upsert({where:{reservationId},create:{reservationId,fingerprint:hash},update:{fingerprint:hash,version:{increment:1}}});
 if(!evidence.reasons.length){
  await tx.financeIssue.updateMany({where:{reservationId,kind:"ACCOUNTING_INCOMPLETE"},data:{status:"RESOLVED",resolution:"Current accounting evidence and checkpoint committed"}});
 }
 return evidence;
}

export async function accountingCompleteness(tx:Prisma.TransactionClient,reservationId:string){
 const evidence=await accountingEvidence(tx,reservationId),checkpoint=await tx.accountingCheckpoint.findUnique({where:{reservationId}});
 if(checkpoint?.fingerprint!==evidence.hash)evidence.reasons.push("Accounting checkpoint is missing or stale");
 return {...evidence,complete:evidence.reasons.length===0};
}

export async function requireAccountingComplete(tx:Prisma.TransactionClient,reservationId:string){
 const result=await accountingCompleteness(tx,reservationId);
 if(!result.complete)throw new Error("Accounting incomplete: "+result.reasons.join("; "));
 return result;
}
