import type { Prisma,PrismaClient } from "@prisma/client";
import { Temporal } from "@js-temporal/polyfill";
import { prisma } from "@/lib/prisma";
import { reconcileAccounting,financeIssue } from "@/lib/finance-ledger";
import { createPayoutBatch,executeFinanceOperation,planBankPayout,synchronizeConnect } from "@/lib/payout-operations";
import { payoutSchema,selectedRule } from "@/lib/finance-rules";
import { financeStripe } from "@/lib/finance-provider";
import { withReservationLock } from "@/lib/financial-locks";
import { retainProcessingFee } from "@/lib/processing-fees";
import { accountReservation } from "@/lib/finance-ledger";

export function nextPayoutCutoff(schedule:string,zone:string,now=new Date()){
 let date=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(zone).toPlainDate();
 for(let i=0;i<370;i++,date=date.add({days:1})){
  if(schedule==="WEEKLY"&&date.dayOfWeek===1||schedule==="TWICE_MONTHLY"&&[1,15].includes(date.day)||schedule==="MONTHLY"&&date.day===1){const cutoff=new Date(date.toZonedDateTime({timeZone:zone,plainTime:"09:00"}).epochMilliseconds);if(cutoff>now)return cutoff;}
 }
 return new Date(now.getTime()+365*86400000);
}
export async function recoverPayoutOperations(){
 const now=new Date(),rows=await prisma.financialOperation.findMany({where:{kind:{startsWith:"FINANCE_"},state:{in:["READY","RETRY","RUNNING","POLL"]},AND:[{OR:[{nextAttemptAt:null},{nextAttemptAt:{lte:now}}]},{OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lte:now}}]}]},orderBy:[{priority:"asc"},{nextAttemptAt:{sort:"asc",nulls:"first"}},{createdAt:"asc"}],take:25});
 let processed=0,pending=0;for(const op of rows)try{await executeFinanceOperation(op);processed++;}catch{pending++;}
 // An observed bank payout remains pending until Stripe says paid/failed/canceled.
 const batches=await prisma.payoutBatch.findMany({where:{state:{in:["TRANSFERRED","PAYOUT_PENDING"]},nextAttemptAt:{lte:now}},orderBy:{nextAttemptAt:"asc"},take:25});
 for(const b of batches)try{await prisma.payoutBatch.update({where:{id:b.id},data:{nextAttemptAt:new Date(Date.now()+60000)}});const op=b.state==="TRANSFERRED"?await planBankPayout(b.id):await prisma.financialOperation.findUniqueOrThrow({where:{key:`payout:${b.id}:${b.generation}`}});await executeFinanceOperation(op);processed++;}catch{pending++;}
 return {processed,pending};
}
export async function schedulePayouts(){
 const hosts=await prisma.connectAccount.findMany({where:{active:true,schedule:{not:"MANUAL"},nextRunAt:{lte:new Date()}},orderBy:{nextRunAt:"asc"},take:25});let planned=0;
 for(const a of hosts)try{
  const claimed=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT financial_guard_xact(${"host-finance:"+a.hostId})`;const rule=await selectedRule(tx,"PAYOUT",[{scope:"HOST",scopeId:a.hostId},{scope:"DEFAULT",scopeId:"*"}]);const defer=async()=>{await tx.connectAccount.updateMany({where:{hostId:a.hostId,nextRunAt:a.nextRunAt},data:{nextRunAt:new Date(Date.now()+15*60000)}});await financeIssue(tx,{key:"schedule:"+a.hostId,kind:"SCHEDULE_REVIEW",hostId:a.hostId,reason:"Schedule or threshold needs current business approval; work deferred without moving money"});return false;};if(!rule)return defer();const p=payoutSchema.parse(rule.config);if(!p.allowedSchedules.includes(a.schedule as "MANUAL")||a.minimumCents<p.minimumCents)return defer();await tx.financeIssue.updateMany({where:{key:"schedule:"+a.hostId,status:{not:"RESOLVED"}},data:{status:"RESOLVED",resolution:"Current immutable business rule confirms the selected schedule and threshold"}});const changed=await tx.connectAccount.updateMany({where:{hostId:a.hostId,nextRunAt:a.nextRunAt},data:{nextRunAt:nextPayoutCutoff(a.schedule,a.timezone)}});if(changed.count)await tx.outboxMessage.upsert({where:{deliveryKey:`finance-schedule:${a.hostId}:${a.nextRunAt.toISOString()}`},create:{type:"finance_schedule",deliveryKey:`finance-schedule:${a.hostId}:${a.nextRunAt.toISOString()}`,payload:{hostId:a.hostId,cutoff:new Date().toISOString()}},update:{}});return Boolean(changed.count);});
  if(claimed)planned++;
 }catch{await financeIssue(prisma,{key:"schedule:"+a.hostId,kind:"SCHEDULE_REVIEW",hostId:a.hostId,reason:"Scheduled payout remains pending; operator review required"});}
 return {planned};
}
export async function reconcileFinance(){
 const metrics=await financeBacklogAlerts();const accounting=await reconcileAccounting();const rows=await prisma.financeIssue.findMany({where:{status:{not:"RESOLVED"}},orderBy:[{checkedAt:{sort:"asc",nulls:"first"}},{createdAt:"asc"}],take:25});
 let checked=0;for(const issue of rows){await prisma.financeIssue.update({where:{id:issue.id},data:{checkedAt:new Date()}});if(issue.operationId){const op=await prisma.financialOperation.findUnique({where:{id:issue.operationId}});if(op?.providerId&&op.state!=="REVIEW")try{await executeFinanceOperation(op);}catch{/* Remains visible, never silently written off. */}}
  if(issue.kind==="UNMATCHED_PROVIDER_OBJECT"){const providerId=(issue.evidence as {providerId?:string})?.providerId,owner=providerId?await prisma.financeObject.findUnique({where:{providerId}}):null;if(owner){const op=await prisma.financialOperation.findUniqueOrThrow({where:{id:owner.operationId}});try{await executeFinanceOperation(op);await prisma.financeIssue.update({where:{id:issue.id},data:{status:"RESOLVED",resolution:"Reconciled against immutable owned operation "+op.id}});await prisma.auditLog.create({data:{action:"finance.unmatched.reconciled",entityType:"FinanceIssue",entityId:issue.id,metadata:{operationId:op.id,providerId}}});}catch{/* Still unexplained; retain the hold. */}}}
  checked++;}
 const mismatches=await prisma.$queryRaw<Array<{id:string}>>`SELECT j.id FROM "LedgerJournal" j LEFT JOIN "LedgerLine" l ON l."journalId"=j.id GROUP BY j.id HAVING COALESCE(sum(l."debitCents"::bigint-l."creditCents"::bigint),0)<>0 OR count(l.id)<2 LIMIT 25`;
 for(const j of mismatches)await financeIssue(prisma,{key:"imbalance:"+j.id,kind:"LEDGER_IMBALANCE",reason:"Ledger invariant violation requires immediate investigation",evidence:{journalId:j.id}});
 return {...accounting,checked,imbalances:mismatches.length,metrics};
}
export async function auditFinanceHistory(){
 const stripe=financeStripe(),rows=await prisma.reservation.findMany({where:{payments:{some:{status:"SUCCEEDED",stripePaymentIntentId:{not:null}}}},orderBy:[{financialCheckedAt:{sort:"asc",nulls:"first"}},{id:"asc"}],take:10,include:{payments:true,refunds:true}});
 for(const r of rows){await prisma.reservation.update({where:{id:r.id},data:{financialCheckedAt:new Date()}});for(const p of r.payments.filter(p=>p.stripePaymentIntentId)){
  const intent=await stripe.paymentIntents.retrieve(p.stripePaymentIntentId!,{expand:["latest_charge.balance_transaction"]});
  if((p.type==="DEPOSIT_CAPTURE"?intent.amount_received:intent.amount)!==p.amountCents||intent.currency!==p.currency||p.status==="SUCCEEDED"&&!(p.type==="DEPOSIT_AUTH"?["requires_capture","canceled","succeeded"].includes(intent.status):intent.status==="succeeded"))await financeIssue(prisma,{key:"provider-payment:"+p.id,kind:"PROVIDER_PAYMENT_DIFFERENCE",reservationId:r.id,reason:"Provider payment amount/currency/status differs from internal evidence",evidence:{paymentId:p.id,providerId:intent.id}});
  const charge=typeof intent.latest_charge==="object"?intent.latest_charge:null,balance=charge&&typeof charge.balance_transaction==="object"?charge.balance_transaction:null;
  if(balance&&p.status==="SUCCEEDED"&&p.type!=="DEPOSIT_AUTH"){await retainProcessingFee(p.id,balance);await withReservationLock(r.id,tx=>accountReservation(tx,r.id));}
 }
 for(const refund of r.refunds.filter(f=>f.stripeRefundId)){
  const actual=await stripe.refunds.retrieve(refund.stripeRefundId!);
  if(actual.amount!==refund.amountCents||actual.currency!==(r.payments.find(p=>p.id===refund.paymentId)?.currency??"usd")||refund.status==="SUCCEEDED"&&actual.status!=="succeeded")await financeIssue(prisma,{key:"provider-refund:"+refund.id,kind:"PROVIDER_REFUND_DIFFERENCE",reservationId:r.id,reason:"Provider refund differs from retained amount, currency or terminal status",evidence:{refundId:refund.id,providerId:actual.id}});
 }
 }const payouts=await auditPayoutHistory();return {checked:rows.length,payouts};
}
export const payoutWorkers={accounting:reconcileAccounting,recovery:recoverPayoutOperations,schedule:schedulePayouts,reconciliation:reconcileFinance,"historical-audit":auditFinanceHistory};

export async function executeScheduledPayout(id:string,token:string,payload:Prisma.JsonValue,db:PrismaClient=prisma){const p=payload as {hostId:string;cutoff:string};if(!p.hostId||!p.cutoff||!Number.isFinite(Date.parse(p.cutoff)))throw new Error("Invalid immutable payout schedule intent");await synchronizeConnect(p.hostId);return createPayoutBatch(p.hostId,db,{id,token,cutoff:new Date(p.cutoff)});}

export async function financeBacklogAlerts(){
 const cutoff=new Date(Date.now()-15*60000);
 const [operations,scheduled]=await Promise.all([
  prisma.financialOperation.count({where:{kind:{startsWith:"FINANCE_"},OR:[{state:"REVIEW"},{state:{in:["READY","RETRY","RUNNING","POLL"]},createdAt:{lt:cutoff}}]}}),
  prisma.outboxMessage.count({where:{type:"finance_schedule",status:{in:["PENDING","FAILED"]},createdAt:{lt:cutoff}}})
 ]);
 const metrics={operations,scheduled,thresholdMinutes:15};
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT financial_guard_xact(${"finance-backlog-alert"})`;
  const prior=await tx.financeIssue.findUnique({where:{key:"finance-worker-backlog"}});
  if(operations+scheduled){
   const issue=await financeIssue(tx,{key:"finance-worker-backlog",kind:"WORKER_BACKLOG",reason:"Finance work requires operator attention; inspect recovery and scheduled delivery queues",evidence:metrics});
   if(!prior||prior.status==="RESOLVED"){
    const actors=await tx.user.findMany({where:{isActive:true,role:{in:["FINANCE_AGENT","ADMIN","SUPER_ADMIN"]}},select:{id:true}});
    const eventKey="finance-backlog:"+issue.id+":"+Date.now();
    await tx.inboxNotice.createMany({data:actors.map(a=>({eventKey,userId:a.id,category:"FINANCE",title:"Finance worker backlog requires attention",resourceType:"FINANCE",resourceId:issue.id,required:true}))});
    await tx.auditLog.create({data:{action:"finance.backlog.alert",entityType:"FinanceIssue",entityId:issue.id,metadata:metrics}});
   }
  }else if(prior&&prior.status!=="RESOLVED"){
   await tx.financeIssue.update({where:{id:prior.id},data:{status:"RESOLVED",resolution:"Worker metrics returned below the alert threshold",evidence:metrics}});
   await tx.auditLog.create({data:{action:"finance.backlog.cleared",entityType:"FinanceIssue",entityId:prior.id}});
  }
 });return metrics;
}

export async function auditPayoutHistory(){
 // Separate bounded historical work; urgent recovery never waits behind it.
 const rows=await prisma.financialOperation.findMany({where:{kind:{in:["FINANCE_TRANSFER","FINANCE_PAYOUT","FINANCE_REVERSAL"]},state:"OBSERVED",providerId:{not:null}},orderBy:[{updatedAt:"asc"},{id:"asc"}],take:10});
 for(const op of rows)try{await executeFinanceOperation(op);}catch{
  await financeIssue(prisma,{key:"historical-operation:"+op.id,kind:"FINANCE_PROVIDER_DIFFERENCE",operationId:op.id,hostId:(op.payload as {hostId:string}).hostId,reason:"Historical provider object differs or cannot be reconciled; preserve the financial hold"});
 }
 return {checked:rows.length};
}
