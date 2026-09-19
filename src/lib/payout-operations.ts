import type { FinancialOperation,Prisma,PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { prepareOperation,runOperation,json } from "@/lib/financial-operations";
import { lockFinanceOperation,lockPayoutReservations,payoutEligibility } from "@/lib/payout-authority";
import { accountReservation,journal,financeIssue } from "@/lib/finance-ledger";
import { financeHost,financeAdmin,financeStepUp } from "@/lib/finance-access";
import { createFinanceProviderObject,retrieveFinanceProviderObject,discoverFinanceProviderObject,createOnboardingLink,retrieveConnectAccount,type FinanceProviderObject,type FinancePayload } from "@/lib/finance-provider";
import { MarketplaceError } from "@/lib/marketplace";

export async function applyFinanceObject(tx:Prisma.TransactionClient,op:FinancialOperation,result:FinanceProviderObject){
 const p=op.payload as FinancePayload;
 if(result.kind!==op.kind||result.hostId!==p.hostId||result.operationKey!==op.key||p.accountId&&result.accountId!==p.accountId||p.amount!==undefined&&(result.amount!==p.amount||result.currency!==p.currency))throw new Error("Provider object does not match immutable operation");
 if(op.kind==="FINANCE_CONNECT"){
  const a=await tx.connectAccount.findUniqueOrThrow({where:{hostId:p.hostId}});if(a.accountId&&a.accountId!==result.id)throw new Error("Connect ownership changed");
  await tx.connectAccount.update({where:{hostId:p.hostId},data:{accountId:result.id,detailsSubmitted:result.detailsSubmitted,chargesEnabled:result.chargesEnabled,payoutsEnabled:result.payoutsEnabled,currentlyDue:json(result.currentlyDue??[]),eventuallyDue:json(result.eventuallyDue??[]),disabledReason:result.disabledReason,verificationStatus:result.status==="verified"?"VERIFIED":"REQUIRES_ACTION",taxStatus:(result.currentlyDue??[]).some(x=>/tax|ssn|id_number/.test(x))?"REQUIRES_ACTION":result.detailsSubmitted?"VERIFIED":"PENDING",synchronizedAt:new Date()}});return;
 }
 const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id:p.batchId}});
 if(op.kind==="FINANCE_TRANSFER"){
  if(batch.transferId&&batch.transferId!==result.id)throw new Error("Transfer ownership mismatch");
  await journal(tx,{key:"transfer:"+result.id,kind:"HOST_TRANSFER",currency:batch.currency,hostId:batch.hostId,operationId:op.id,providerId:result.id,description:"Host earnings transferred to owned Connect balance",lines:[{account:"HOST_PAYABLE",debitCents:result.amount},{account:"STRIPE_CLEARING",creditCents:result.amount},{account:"MEMO_CONNECT_FUNDS",debitCents:result.amount},{account:"MEMO_CONNECT_LIABILITY",creditCents:result.amount}]});
  await tx.payoutBatch.update({where:{id:batch.id},data:{transferId:result.id,transferredCents:result.amount,...(!["PAID","PAYOUT_PENDING","REVERSED"].includes(batch.state)?{state:"TRANSFERRED"}:{})}});
  if(result.amountReversed!==batch.reversedCents)await financeIssue(tx,{key:"transfer-difference:"+result.id,kind:"REVERSAL_DIFFERENCE",hostId:batch.hostId,operationId:op.id,reason:"Provider reversal total differs from posted internal reversal evidence",evidence:json({providerReversed:result.amountReversed,internalReversed:batch.reversedCents})});
 }else if(op.kind==="FINANCE_PAYOUT"){
  if(op.key!==`payout:${batch.id}:${batch.generation}`)return;
  if(batch.payoutId&&batch.payoutId!==result.id)throw new Error("Payout ownership mismatch");
  const terminal=["paid","failed","canceled"].includes(result.status);
  if(batch.state==="PAID"&&result.status!=="paid"){await financeIssue(tx,{key:"payout-regression:"+result.id,kind:"PAYOUT_DIFFERENCE",hostId:batch.hostId,reason:"Authoritative payout status changed after paid; investigate return without reopening earnings"});return;}
  if(result.status==="paid")await journal(tx,{key:"payout:"+result.id,kind:"HOST_PAYOUT",currency:batch.currency,hostId:batch.hostId,operationId:op.id,providerId:result.id,description:"Stripe confirmed bank payout",lines:[{account:"MEMO_CONNECT_LIABILITY",debitCents:result.amount},{account:"MEMO_CONNECT_FUNDS",creditCents:result.amount}]});
  await tx.payoutBatch.update({where:{id:batch.id},data:{payoutId:result.id,state:result.status==="paid"?"PAID":terminal?"PAYOUT_FAILED":"PAYOUT_PENDING",reason:terminal&&result.status!=="paid"?"Stripe confirmed payout "+result.status:null,nextAttemptAt:new Date(Date.now()+60000)}});
 }else if(op.kind==="FINANCE_REVERSAL"){
  const reversal=await tx.payoutReversal.findUniqueOrThrow({where:{id:p.reversalId}});if(reversal.state==="SUCCEEDED")return;
  if(reversal.amountCents!==result.amount||batch.reversalReservedCents<result.amount)throw new Error("Reversal balance mismatch");
  await journal(tx,{key:"transfer-reversal:"+result.id,kind:"TRANSFER_REVERSAL",currency:batch.currency,hostId:batch.hostId,operationId:op.id,providerId:result.id,description:reversal.reason,lines:[{account:"STRIPE_CLEARING",debitCents:result.amount},{account:"HOST_RECEIVABLE",creditCents:result.amount}]});
  await tx.payoutReversal.update({where:{id:reversal.id},data:{state:"SUCCEEDED",providerId:result.id}});
  await tx.payoutBatch.update({where:{id:batch.id},data:{reversedCents:{increment:result.amount},reversalReservedCents:{decrement:result.amount},...(batch.reversedCents+result.amount===batch.transferredCents?{state:"REVERSED"}:{})}});
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
export async function createPayoutBatch(hostId:string,db:PrismaClient=prisma){
 // Select before locking; re-read every candidate after guards. Rotating checkedAt
 // prevents a large held backlog from starving later eligible earnings.
 const candidates=await db.hostEarning.findMany({where:{hostId},orderBy:[{checkedAt:{sort:"asc",nulls:"first"}},{id:"asc"}],take:50});
 return db.$transaction(async tx=>{
  await lockPayoutReservations(tx,candidates.map(e=>e.reservationId),hostId);
  const account=await tx.connectAccount.findUniqueOrThrow({where:{hostId}}),items:Array<{earningId:string;reservationId:string;amountCents:number}>=[];
  for(const e of candidates){await accountReservation(tx,e.reservationId);const result=await payoutEligibility(tx,e.reservationId);await tx.hostEarning.update({where:{id:e.id},data:{checkedAt:new Date(),availableAt:result.availableAt,holdReason:result.reasons.join("; ")||null}});if(result.eligible)items.push({earningId:e.id,reservationId:e.reservationId,amountCents:result.amountCents});}
  const amount=items.reduce((n,i)=>n+i.amountCents,0);if(!amount||amount<account.minimumCents)return {id:null,reason:amount?"Balance below minimum; deferred":"No eligible earnings"};
  const currencies=new Set(candidates.filter(c=>items.some(i=>i.earningId===c.id)).map(c=>c.currency));if(currencies.size!==1)throw new Error("Mixed currencies cannot form a payout");
  const batch=await tx.payoutBatch.create({data:{hostId,accountId:account.accountId!,currency:[...currencies][0],amountCents:amount}});
  await tx.payoutItem.createMany({data:items.map(i=>({...i,batchId:batch.id}))});
  await prepareOperation(tx,{key:"transfer:"+batch.id,kind:"FINANCE_TRANSFER",payload:json({hostId,batchId:batch.id,accountId:batch.accountId,amount,currency:batch.currency})});
  return {id:batch.id};
 },{maxWait:15000,timeout:15000});
}
export async function planBankPayout(batchId:string){return prisma.$transaction(async tx=>{const b=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}}),items=await tx.payoutItem.findMany({where:{batchId}});await lockPayoutReservations(tx,items.map(i=>i.reservationId),b.hostId);const current=await tx.payoutBatch.findUniqueOrThrow({where:{id:batchId}});if(current.state!=="TRANSFERRED"||current.reversedCents||current.reversalReservedCents)throw new MarketplaceError("Batch is not ready for bank payout.",409);return prepareOperation(tx,{key:`payout:${batchId}:${current.generation}`,kind:"FINANCE_PAYOUT",payload:json({hostId:b.hostId,batchId,accountId:b.accountId,amount:b.amountCents,currency:b.currency})});});}
export async function planTransferReversal(userId:string,issueId:string,code:string){return prisma.$transaction(async tx=>{
 await financeAdmin(tx,userId,true);const issue=await tx.financeIssue.findUniqueOrThrow({where:{id:issueId}});if(issue.kind!=="POST_PAYOUT_REFUND"||issue.status==="RESOLVED")throw new MarketplaceError("An unresolved approved refund recovery is required.",409);
 const evidence=issue.evidence as {batchId:string;refundId:string;hostCents:number;reverseTransfers:boolean};if(!evidence.reverseTransfers)throw new MarketplaceError("Frozen business policy does not authorize transfer reversal.",409);
 const b=await tx.payoutBatch.findUniqueOrThrow({where:{id:evidence.batchId}}),items=await tx.payoutItem.findMany({where:{batchId:b.id}});await lockPayoutReservations(tx,items.map(i=>i.reservationId),b.hostId);
 const prior=await tx.payoutReversal.findUnique({where:{key:"refund-recovery:"+evidence.refundId}});if(prior)return{id:prior.id};
 await financeStepUp(tx,userId,code);
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
