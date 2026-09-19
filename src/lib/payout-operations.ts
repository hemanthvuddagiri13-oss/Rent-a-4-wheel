import type { FinancialOperation,Prisma,PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { prepareOperation,runOperation,json } from "@/lib/financial-operations";
import { lockFinanceOperation,lockPayoutReservations,payoutEligibility } from "@/lib/payout-authority";
import { accountReservation,journal,financeIssue } from "@/lib/finance-ledger";
import { financeHost,financeAdmin,financeStepUp } from "@/lib/finance-access";
import { createFinanceProviderObject,retrieveFinanceProviderObject,discoverFinanceProviderObject,createOnboardingLink,retrieveConnectAccount,type FinanceProviderObject,type FinancePayload } from "@/lib/finance-provider";
import { MarketplaceError } from "@/lib/marketplace";
import { independentCaseActor } from "@/lib/case-decision-authority";

export async function applyFinanceObject(tx:Prisma.TransactionClient,op:FinancialOperation,result:FinanceProviderObject){
 const p=op.payload as FinancePayload;
 if(result.kind!==op.kind||result.hostId!==p.hostId||result.operationKey!==op.key||p.accountId&&result.accountId!==p.accountId||p.amount!==undefined&&(result.amount!==p.amount||result.currency!==p.currency))throw new Error("Provider object does not match immutable operation");
 if(op.kind==="FINANCE_CONNECT"){
  const a=await tx.connectAccount.findUniqueOrThrow({where:{hostId:p.hostId}});if(a.accountId&&a.accountId!==result.id)throw new Error("Connect ownership changed");
  await tx.connectAccount.update({where:{hostId:p.hostId},data:{accountId:result.id,detailsSubmitted:result.detailsSubmitted,chargesEnabled:result.chargesEnabled,payoutsEnabled:result.payoutsEnabled,currentlyDue:json(result.currentlyDue??[]),eventuallyDue:json(result.eventuallyDue??[]),disabledReason:result.disabledReason,verificationStatus:result.status==="verified"?"VERIFIED":"REQUIRES_ACTION",taxStatus:result.taxStatus??"PENDING",synchronizedAt:new Date()}});return;
 }
 const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id:p.batchId}});
 if(op.kind==="FINANCE_TRANSFER"){
  if(batch.transferId&&batch.transferId!==result.id)throw new Error("Transfer ownership mismatch");
  await journal(tx,{key:"transfer:"+result.id,kind:"HOST_TRANSFER",currency:batch.currency,hostId:batch.hostId,operationId:op.id,providerId:result.id,description:"Host earnings transferred to owned Connect balance",lines:[{account:"HOST_PAYABLE",debitCents:result.amount},{account:"STRIPE_CLEARING",creditCents:result.amount},{account:"MEMO_CONNECT_FUNDS",debitCents:result.amount},{account:"MEMO_CONNECT_LIABILITY",creditCents:result.amount}]});
  await tx.payoutBatch.update({where:{id:batch.id},data:{transferId:result.id,transferredCents:result.amount,...(batch.state==="PLANNED"?{state:"TRANSFERRED"}:{})}});
  if(result.amountReversed!==batch.reversedCents)await financeIssue(tx,{key:"transfer-difference:"+result.id,kind:"REVERSAL_DIFFERENCE",hostId:batch.hostId,operationId:op.id,reason:"Provider reversal total differs from posted internal reversal evidence",evidence:json({providerReversed:result.amountReversed,internalReversed:batch.reversedCents})});
 }else if(op.kind==="FINANCE_PAYOUT"){
  if(op.key!==`payout:${batch.id}:${batch.generation}`)return;
  if(batch.payoutId&&batch.payoutId!==result.id)throw new Error("Payout ownership mismatch");
  const terminal=["paid","failed","canceled"].includes(result.status);
  if(batch.state==="PAID"&&result.status!=="paid"){await financeIssue(tx,{key:"payout-regression:"+result.id,kind:"PAYOUT_DIFFERENCE",hostId:batch.hostId,reason:"Authoritative payout status changed after paid; investigate return without reopening earnings"});return;}
  if(result.status==="paid")await journal(tx,{key:"payout:"+result.id,kind:"HOST_PAYOUT",currency:batch.currency,hostId:batch.hostId,operationId:op.id,providerId:result.id,description:"Stripe confirmed bank payout",lines:[{account:"MEMO_CONNECT_LIABILITY",debitCents:result.amount},{account:"MEMO_CONNECT_FUNDS",creditCents:result.amount}]});
  await tx.payoutBatch.update({where:{id:batch.id},data:{payoutId:result.id,...(result.status==="paid"?{paidCents:result.amount}:{}),state:result.status==="paid"?"PAID":terminal?"PAYOUT_FAILED":"PAYOUT_PENDING",reason:terminal&&result.status!=="paid"?"Stripe confirmed payout "+result.status:null,nextAttemptAt:new Date(Date.now()+60000)}});
 }else if(op.kind==="FINANCE_REVERSAL"){
  const reversal=await tx.payoutReversal.findUniqueOrThrow({where:{id:p.reversalId}});if(reversal.state==="SUCCEEDED")return;
  if(reversal.amountCents!==result.amount||batch.reversalReservedCents<result.amount)throw new Error("Reversal balance mismatch");
  await journal(tx,{key:"transfer-reversal:"+result.id,kind:"TRANSFER_REVERSAL",currency:batch.currency,hostId:batch.hostId,operationId:op.id,providerId:result.id,description:reversal.reason,lines:[{account:"STRIPE_CLEARING",debitCents:result.amount},{account:"HOST_RECEIVABLE",creditCents:result.amount}]});
  await tx.payoutReversal.update({where:{id:reversal.id},data:{state:"SUCCEEDED",providerId:result.id}});
  await tx.payoutBatch.update({where:{id:batch.id},data:{reversedCents:{increment:result.amount},reversalReservedCents:{decrement:result.amount},...(batch.reversedCents+result.amount===batch.transferredCents?{state:"REVERSED"}:{})}});
  await tx.financeIssue.updateMany({where:{key:reversal.key,kind:"POST_PAYOUT_REFUND"},data:{status:"RESOLVED",resolution:"Owned transfer reversal confirmed by Stripe: "+result.id}});
 }
}
export async function executeFinanceOperation(op:FinancialOperation){return runOperation(op,{create:key=>createFinanceProviderObject(op,key),retrieve:id=>retrieveFinanceProviderObject(op,id),discover:()=>discoverFinanceProviderObject(op),apply:(tx,result)=>applyFinanceObject(tx,op,result)});}

export async function connectOnboarding(userId:string){
 const op=await prisma.$transaction(async tx=>{const {host}=await financeHost(tx,userId,undefined,true);await tx.$queryRaw`SELECT financial_guard_xact(${"host-finance:"+host.id})`;const account=await tx.connectAccount.upsert({where:{hostId:host.id},create:{hostId:host.id},update:{}});if(!account.active)throw new MarketplaceError("Account deactivated; contact finance.",409);const op=await prepareOperation(tx,{key:"connect:"+host.id,kind:"FINANCE_CONNECT",payload:json({hostId:host.id})});await tx.connectAccount.update({where:{hostId:host.id},data:{operationId:op.id}});await tx.auditLog.create({data:{actorId:userId,action:"finance.onboarding.request",entityType:"HostProfile",entityId:host.id}});return op;});
 const result=await executeFinanceOperation(op);
 // Revalidate membership after external work before exposing a one-use URL.
 await financeHost(prisma,userId,(op.payload as FinancePayload).hostId,true);
 const link=await createOnboardingLink(result.id);
 await financeHost(prisma,userId,(op.payload as FinancePayload).hostId,true);
 return {url:link.url};
}
export async function synchronizeConnect(hostId:string){
 const account=await prisma.connectAccount.findUniqueOrThrow({where:{hostId}});if(!account.accountId||!account.operationId)return;
 const result=await retrieveConnectAccount(account.accountId),op=await prisma.financialOperation.findUniqueOrThrow({where:{id:account.operationId}});
 await prisma.$transaction(async tx=>{await lockFinanceOperation(tx,op);await applyFinanceObject(tx,op,result);});
}
export async function createPayoutBatch(hostId:string,db:PrismaClient=prisma,work?:{id:string;token:string;cutoff:Date}){
 // Select before locking; re-read every candidate after guards. Rotating checkedAt
 // prevents a large held backlog from starving later eligible earnings.
 const candidates=await db.hostEarning.findMany({where:{hostId,...(work?{createdAt:{lte:work.cutoff},OR:[{checkedAt:null},{checkedAt:{lt:work.cutoff}}]}:{})},orderBy:[{checkedAt:{sort:"asc",nulls:"first"}},{id:"asc"}],take:50});
 return db.$transaction(async tx=>{
  await lockPayoutReservations(tx,candidates.map(e=>e.reservationId),hostId);
  const finish=async<T>(result:T)=>{if(work){
   if(candidates.length===50)await tx.outboxMessage.upsert({where:{deliveryKey:"finance-schedule-next:"+work.id},create:{type:"finance_schedule",deliveryKey:"finance-schedule-next:"+work.id,payload:{hostId,cutoff:work.cutoff.toISOString()}},update:{}});
   const finished=await tx.outboxMessage.updateMany({where:{id:work.id,leaseToken:work.token,leaseExpiresAt:{gt:new Date()},status:"PENDING"},data:{status:"SENT",processedAt:new Date(),leaseToken:null,leaseExpiresAt:null}});if(!finished.count)throw new MarketplaceError("Scheduled payout lease expired before commit.",409);
  }return result;};
  if(work){const valid=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "OutboxMessage" WHERE id=${work.id} AND "leaseToken"=${work.token} AND status='PENDING' AND "leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE`;if(!valid.length)throw new MarketplaceError("Scheduled payout lease lost.",409);}
  const account=await tx.connectAccount.findUniqueOrThrow({where:{hostId}}),items:Array<{earningId:string;reservationId:string;amountCents:number}>=[];
  let minimum=account.minimumCents;
  for(const e of candidates){await accountReservation(tx,e.reservationId);const result=await payoutEligibility(tx,e.reservationId);await tx.hostEarning.update({where:{id:e.id},data:{checkedAt:new Date(),availableAt:result.availableAt,holdReason:result.reasons.join("; ")||null}});if(result.eligible){minimum=Math.max(minimum,result.minimumCents);items.push({earningId:e.id,reservationId:e.reservationId,amountCents:result.amountCents});}}
  const amount=items.reduce((n,i)=>n+i.amountCents,0);if(!amount||amount<minimum)return finish({id:null,reason:amount?"Balance below approved minimum; deferred":"No eligible earnings"});
  const currencies=new Set(candidates.filter(c=>items.some(i=>i.earningId===c.id)).map(c=>c.currency));if(currencies.size!==1)throw new Error("Mixed currencies cannot form a payout");
  const batch=await tx.payoutBatch.create({data:{hostId,accountId:account.accountId!,currency:[...currencies][0],amountCents:amount}});
  await tx.payoutItem.createMany({data:items.map(i=>({...i,batchId:batch.id}))});
  await prepareOperation(tx,{key:"transfer:"+batch.id,kind:"FINANCE_TRANSFER",payload:json({hostId,batchId:batch.id,accountId:batch.accountId,amount,currency:batch.currency})});
  return finish({id:batch.id});
 },{maxWait:15000,timeout:15000});
}
export async function planBankPayout(batchId:string){return prisma.$transaction(async tx=>{const b=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}}),items=await tx.payoutItem.findMany({where:{batchId}});await lockPayoutReservations(tx,items.map(i=>i.reservationId),b.hostId);const current=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}});if(current.state!=="TRANSFERRED"||current.transferredCents<=current.reversedCents||current.reversalReservedCents)throw new MarketplaceError("Batch is not ready for bank payout.",409);return prepareOperation(tx,{key:`payout:${batchId}:${current.generation}`,kind:"FINANCE_PAYOUT",payload:json({hostId:b.hostId,batchId,accountId:b.accountId,amount:current.transferredCents-current.reversedCents,currency:b.currency})});});}
export async function planTransferReversal(userId:string,issueId:string,code:string){return prisma.$transaction(async tx=>{
 await financeAdmin(tx,userId,true);const issue=await tx.financeIssue.findUniqueOrThrow({where:{id:issueId}});if(issue.kind!=="POST_PAYOUT_REFUND"||issue.status==="RESOLVED")throw new MarketplaceError("An unresolved approved refund recovery is required.",409);
 const evidence=issue.evidence as {batchId:string;refundId:string;hostCents:number;reverseTransfers:boolean};if(!evidence.reverseTransfers)throw new MarketplaceError("Frozen business policy does not authorize transfer reversal.",409);
 const b=await tx.payoutBatch.findUniqueOrThrow({where:{id:evidence.batchId}}),items=await tx.payoutItem.findMany({where:{batchId:b.id}});await lockPayoutReservations(tx,items.map(i=>i.reservationId),b.hostId);
 const locked=await tx.payoutBatch.findUniqueOrThrow({where:{id:b.id}});
 if(locked.state==="PAYOUT_PENDING")throw new MarketplaceError("Reconcile the pending bank payout before reserving transfer recovery.",409);
 for(const item of items){const r=await tx.reservation.findUniqueOrThrow({where:{id:item.reservationId}});await independentCaseActor(tx,{id:issueId,kind:"CLAIM",reservationId:r.id,vehicleId:r.vehicleId,openedById:r.customerId},userId);}
 const prior=await tx.payoutReversal.findUnique({where:{key:"refund-recovery:"+evidence.refundId}});if(prior)return{id:prior.id};
 await financeStepUp(tx,userId,code);
 const bank=await tx.financialOperation.findUnique({where:{key:`payout:${b.id}:${locked.generation}`}});
 if(bank&&!await tx.financialDispatch.count({where:{operationId:bank.id,phase:"DISPATCHED"}})){
  await tx.financialOperation.update({where:{id:bank.id},data:{state:"DEAD_LETTER",leaseToken:null,leaseExpiresAt:null,lastError:"SUPERSEDED_BY_APPROVED_RECOVERY"}});
  await tx.payoutBatch.update({where:{id:b.id},data:{generation:{increment:1}}});
 }
 const reserved=await tx.$executeRaw`UPDATE "PayoutBatch" SET "reversalReservedCents"="reversalReservedCents"+${evidence.hostCents} WHERE id=${b.id} AND "transferredCents"-"reversedCents"-"reversalReservedCents">=${evidence.hostCents}`;if(!reserved)throw new MarketplaceError("Reversal exceeds unreserved transferred funds.",409);
 const reversal=await tx.payoutReversal.create({data:{key:"refund-recovery:"+evidence.refundId,batchId:b.id,amountCents:evidence.hostCents,reason:"Approved allocation of succeeded customer refund"}});
 const op=await prepareOperation(tx,{key:"reversal:"+reversal.id,kind:"FINANCE_REVERSAL",payload:json({hostId:b.hostId,batchId:b.id,accountId:b.accountId,transferId:b.transferId,amount:reversal.amountCents,currency:b.currency,reversalId:reversal.id})});await tx.payoutReversal.update({where:{id:reversal.id},data:{operationId:op.id}});
 await tx.auditLog.create({data:{actorId:userId,action:"finance.reversal.authorized",entityType:"PayoutReversal",entityId:reversal.id,metadata:{issueId}}});return{id:reversal.id};
});}
export async function retryBankPayout(userId:string,id:string,code:string){
 await financeAdmin(prisma,userId,true);
 const batch=await prisma.payoutBatch.findUniqueOrThrow({where:{id}}),old=await prisma.financialOperation.findUniqueOrThrow({where:{key:`payout:${id}:${batch.generation}`}});
 await executeFinanceOperation(old); // Retrieve authoritative failure before releasing retry authority.
 return prisma.$transaction(async tx=>{await lockFinanceOperation(tx,old);await financeStepUp(tx,userId,code);const b=await tx.payoutBatch.findUniqueOrThrow({where:{id}});if(b.state!=="PAYOUT_FAILED")throw new MarketplaceError("Stripe-confirmed failed/canceled payout required.",409);await tx.payoutBatch.update({where:{id},data:{state:"TRANSFERRED",payoutId:null,generation:{increment:1},reason:null}});await tx.auditLog.create({data:{actorId:userId,action:"finance.payout.retry",entityType:"PayoutBatch",entityId:id}});return{id};});
}

export async function voidUndispatchedBatch(userId:string,id:string,code:string,reason:string){
 if(reason.trim().length<10)throw new MarketplaceError("A specific reason is required.");
 return prisma.$transaction(async tx=>{
  await financeAdmin(tx,userId,true);const initial=await tx.payoutBatch.findUniqueOrThrow({where:{id}}),items=await tx.payoutItem.findMany({where:{batchId:id}});await lockPayoutReservations(tx,items.map(i=>i.reservationId),initial.hostId);
  const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id}}),operations=await tx.financialOperation.findMany({where:{kind:{startsWith:"FINANCE_"},payload:{path:["batchId"],equals:id}}});
  if(batch.state==="VOIDED")return{id};
  if(batch.transferredCents||batch.transferId||await tx.financialDispatch.count({where:{operationId:{in:operations.map(o=>o.id)},phase:"DISPATCHED"}}))throw new MarketplaceError("Dispatched outcomes must be reconciled; this batch cannot be voided.",409);
  await financeStepUp(tx,userId,code);
  await tx.financialOperation.updateMany({where:{id:{in:operations.map(o=>o.id)}},data:{state:"DEAD_LETTER",leaseToken:null,leaseExpiresAt:null,lastError:"UNDISPATCHED_BATCH_VOIDED"}});
  await tx.payoutBatch.update({where:{id},data:{state:"VOIDED",reason}});await tx.payoutItem.updateMany({where:{batchId:id,active:true},data:{active:false}});
  await tx.financeIssue.updateMany({where:{kind:"BATCH_CHANGED",evidence:{path:["batchId"],equals:id},status:{not:"RESOLVED"}},data:{status:"RESOLVED",resolution:"Undispatched batch voided without money movement: "+reason,resolvedById:userId}});
  await tx.auditLog.create({data:{actorId:userId,action:"finance.batch.voided",entityType:"PayoutBatch",entityId:id,metadata:{reason}}});return{id};
 });
}
