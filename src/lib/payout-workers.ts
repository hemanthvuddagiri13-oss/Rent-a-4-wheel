import { Temporal } from "@js-temporal/polyfill";
import { prisma } from "@/lib/prisma";
import { reconcileAccounting,financeIssue } from "@/lib/finance-ledger";
import { createPayoutBatch,executeFinanceOperation,planBankPayout,synchronizeConnect } from "@/lib/payout-operations";
import { payoutSchema,selectedRule } from "@/lib/finance-rules";
import { financeStripe } from "@/lib/finance-provider";
import { withReservationLock } from "@/lib/financial-locks";

export function nextPayoutCutoff(schedule:string,zone:string,now=new Date()){
 let date=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(zone).toPlainDate().add({days:1});
 for(let i=0;i<370;i++,date=date.add({days:1})){
  if(schedule==="WEEKLY"&&date.dayOfWeek===1||schedule==="TWICE_MONTHLY"&&[1,15].includes(date.day)||schedule==="MONTHLY"&&date.day===1)return new Date(date.toZonedDateTime({timeZone:zone,plainTime:"09:00"}).epochMilliseconds);
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
  const claimed=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT financial_guard_xact(${"host-finance:"+a.hostId})`;const rule=await selectedRule(tx,"PAYOUT",[{scope:"HOST",scopeId:a.hostId},{scope:"DEFAULT",scopeId:"*"}]);if(!rule)return false;const p=payoutSchema.parse(rule.config);if(!p.allowedSchedules.includes(a.schedule as "MANUAL")||a.minimumCents<p.minimumCents)return false;const changed=await tx.connectAccount.updateMany({where:{hostId:a.hostId,nextRunAt:a.nextRunAt},data:{nextRunAt:nextPayoutCutoff(a.schedule,a.timezone)}});return Boolean(changed.count);});
  if(claimed){await synchronizeConnect(a.hostId);if((await createPayoutBatch(a.hostId)).id)planned++;}
 }catch{await financeIssue(prisma,{key:"schedule:"+a.hostId,kind:"SCHEDULE_REVIEW",hostId:a.hostId,reason:"Scheduled payout remains pending; operator review required"});}
 return {planned};
}
export async function reconcileFinance(){
 const accounting=await reconcileAccounting();const rows=await prisma.financeIssue.findMany({where:{status:{not:"RESOLVED"}},orderBy:[{checkedAt:{sort:"asc",nulls:"first"}},{createdAt:"asc"}],take:25});
 let checked=0;for(const issue of rows){await prisma.financeIssue.update({where:{id:issue.id},data:{checkedAt:new Date()}});if(issue.operationId){const op=await prisma.financialOperation.findUnique({where:{id:issue.operationId}});if(op?.providerId&&op.state!=="REVIEW")try{await executeFinanceOperation(op);}catch{/* Remains visible, never silently written off. */}}checked++;}
 const mismatches=await prisma.$queryRaw<Array<{id:string}>>`SELECT j.id FROM "LedgerJournal" j LEFT JOIN "LedgerLine" l ON l."journalId"=j.id GROUP BY j.id HAVING COALESCE(sum(l."debitCents"::bigint-l."creditCents"::bigint),0)<>0 OR count(l.id)<2 LIMIT 25`;
 for(const j of mismatches)await financeIssue(prisma,{key:"imbalance:"+j.id,kind:"LEDGER_IMBALANCE",reason:"Ledger invariant violation requires immediate investigation",evidence:{journalId:j.id}});
 return {...accounting,checked,imbalances:mismatches.length};
}
export async function auditFinanceHistory(){
 const stripe=financeStripe(),rows=await prisma.reservation.findMany({where:{payments:{some:{status:"SUCCEEDED",stripePaymentIntentId:{not:null}}}},orderBy:[{financialCheckedAt:{sort:"asc",nulls:"first"}},{id:"asc"}],take:10,include:{payments:true}});
 for(const r of rows){await prisma.reservation.update({where:{id:r.id},data:{financialCheckedAt:new Date()}});for(const p of r.payments.filter(p=>p.stripePaymentIntentId)){
  const intent=await stripe.paymentIntents.retrieve(p.stripePaymentIntentId!,{expand:["latest_charge.balance_transaction"]});
  if(intent.amount!==p.amountCents||intent.currency!==p.currency||p.status==="SUCCEEDED"&&intent.status!=="succeeded")await financeIssue(prisma,{key:"provider-payment:"+p.id,kind:"PROVIDER_PAYMENT_DIFFERENCE",reservationId:r.id,reason:"Provider payment amount/currency/status differs from internal evidence",evidence:{paymentId:p.id,providerId:intent.id}});
  const charge=typeof intent.latest_charge==="object"?intent.latest_charge:null,balance=charge&&typeof charge.balance_transaction==="object"?charge.balance_transaction:null;
  if(balance&&balance.fee>0){const {journal}=await import("@/lib/finance-ledger");await withReservationLock(r.id,tx=>journal(tx,{key:"stripe-fee:"+balance.id,kind:"STRIPE_FEE",currency:balance.currency,reservationId:r.id,providerId:balance.id,description:"Provider-reported processing fee",lines:[{account:"STRIPE_FEE_EXPENSE",debitCents:balance.fee},{account:"STRIPE_CLEARING",creditCents:balance.fee}]}));}
 }}return {checked:rows.length};
}
export const payoutWorkers={accounting:reconcileAccounting,recovery:recoverPayoutOperations,schedule:schedulePayouts,reconciliation:reconcileFinance,"historical-audit":auditFinanceHistory};
