import type { Prisma } from "@prisma/client";
import { financeIssue } from "@/lib/finance-ledger";

// Every generation participates, including superseded and quarantined intents.
// The caller owns the batch's reservation + host guards. Projection records are
// committed with journals; an accepted receipt alone is never a balance.
export async function bankMovement(tx:Prisma.TransactionClient,batchId:string){
 const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}});
 const operations=await tx.financialOperation.findMany({where:{kind:"FINANCE_PAYOUT",payload:{path:["batchId"],equals:batchId}},include:{dispatches:true}});
 const projections=await tx.payoutBankProjection.findMany({where:{batchId}});
 const reasons:string[]=[];let pending=0,paid=0;
 if(batch.transferredCents){
  const transfer=await tx.ledgerJournal.findUnique({where:{key:"transfer:"+batch.transferId},include:{lines:true}});
  if(!transfer||transfer.lines.filter(l=>l.account==="MEMO_CONNECT_FUNDS").reduce((n,l)=>n+l.debitCents,0)!==batch.transferredCents)reasons.push("Transfer balance lacks its accounting journal");
 }
 const reversals=await tx.payoutReversal.findMany({where:{batchId,state:"SUCCEEDED"}});
 if(reversals.reduce((n,r)=>n+r.amountCents,0)!==batch.reversedCents)reasons.push("Reversed balance differs from provider projections");
 for(const r of reversals){const j=await tx.ledgerJournal.findUnique({where:{key:"transfer-reversal-memo:"+r.providerId},include:{lines:true}});if(!j||j.lines.filter(l=>l.account==="MEMO_CONNECT_FUNDS").reduce((n,l)=>n+l.creditCents,0)!==r.amountCents)reasons.push("Reversal lacks tracked Connect accounting: "+r.id);}
 for(const op of operations){
  const projection=projections.find(p=>p.operationId===op.id),payload=op.payload as {amount:number;currency:string};
  const effect=Boolean(op.providerId||op.result||op.dispatches.some(d=>["DISPATCHED","SUCCEEDED","UNCERTAIN"].includes(d.phase))||await tx.financeObject.count({where:{operationId:op.id}}));
  if(!effect){if(projection||["REVIEW","UNCERTAIN"].includes(op.state))reasons.push("Bank movement has unresolved evidence: "+op.id);continue;}
  const result=op.result as {id?:string;status?:string;amount?:number}|null;
  if(!projection||op.state!=="OBSERVED"||projection.providerId!==op.providerId||projection.providerId!==result?.id||projection.status!==result.status||projection.amountCents!==payload.amount||projection.currency!==payload.currency){reasons.push("Bank movement not authoritatively projected: "+op.id);continue;}
  const owner=await tx.financeObject.findUnique({where:{providerId:projection.providerId}});
  if(owner?.operationId!==op.id||owner.hostId!==batch.hostId)reasons.push("Bank provider ownership is inconsistent: "+op.id);
  if(await tx.stripeEvent.count({where:{status:{not:"PROCESSED"},type:{startsWith:"payout."},payload:{path:["data","object","id"],equals:projection.providerId}}}))reasons.push("Bank webhook awaits authoritative reconciliation: "+op.id);
  if(projection.status==="paid"){
   const j=await tx.ledgerJournal.findUnique({where:{key:"payout:"+projection.providerId},include:{lines:true}});
   if(!j||j.lines.filter(l=>l.account==="MEMO_CONNECT_FUNDS").reduce((n,l)=>n+l.creditCents,0)!==projection.amountCents)reasons.push("Paid bank movement lacks journal: "+op.id);
   paid+=projection.amountCents;
  }else if(!["failed","canceled"].includes(projection.status)){pending+=projection.amountCents;reasons.push("Bank payout pending: "+op.id);}
 }
 if(paid!==batch.paidCents||pending!==batch.pendingBankCents)reasons.push("Bank amounts differ from projected generations");
 const available=batch.transferredCents-paid-pending-batch.reversedCents;
 if(available<0||available<batch.reversalReservedCents)reasons.push("Tracked Connect balance is inconsistent");
 const unresolved=await tx.financeIssue.count({where:{status:{not:"RESOLVED"},kind:{not:"BANK_MOVEMENT_INCOMPLETE"},OR:[{operationId:{in:operations.map(o=>o.id)}},{evidence:{path:["providerId"],equals:batch.payoutId??"__none__"}},{hostId:batch.hostId,reservationId:null,kind:{in:["PROVIDER_UNCERTAIN","PAYOUT_DIFFERENCE","REVERSAL_DIFFERENCE","FINANCE_PROVIDER_DIFFERENCE","UNMATCHED_PROVIDER_OBJECT","LEDGER_IMBALANCE"]}},{hostId:null,reservationId:null,kind:{in:["UNMATCHED_PROVIDER_OBJECT","LEDGER_IMBALANCE"]}}]}});
 if(unresolved)reasons.push("Bank reconciliation unresolved");
 return {batch,reasons,complete:reasons.length===0,pendingCents:pending,paidCents:paid,availableCents:Math.max(0,available),unreservedCents:Math.max(0,available-batch.reversalReservedCents)};
}

export async function recordBankMovementHold(tx:Prisma.TransactionClient,batchId:string,reasons:string[]){
 const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}});
 await financeIssue(tx,{key:"bank-movement:"+batchId,kind:"BANK_MOVEMENT_INCOMPLETE",hostId:batch.hostId,reason:reasons.join("; "),evidence:{batchId}});
}

export async function transferMayHaveMoved(tx:Prisma.TransactionClient,batchId:string){
 const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}});
 if(batch.transferredCents||batch.transferId)return true;
 const operations=await tx.financialOperation.findMany({where:{kind:"FINANCE_TRANSFER",payload:{path:["batchId"],equals:batchId}},include:{dispatches:true}});
 return operations.some(o=>o.providerId||o.dispatches.some(d=>["DISPATCHED","SUCCEEDED","UNCERTAIN"].includes(d.phase)));
}
