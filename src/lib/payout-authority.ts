import type { FinancialOperation,Prisma } from "@prisma/client";
import {requireReservationJurisdiction} from "@/lib/jurisdiction";
import { assertReturnFinancialAuthority } from "@/lib/return-financial-authority";
import { lockReservation,assertEventFence } from "@/lib/financial-locks";
import { OperationPendingError } from "@/lib/financial-errors";
import { accountingCompleteness } from "@/lib/finance-completeness";
import { bankMovement,recordBankMovementHold } from "@/lib/payout-movement";
import { financeIssue } from "@/lib/finance-ledger";

export async function financeOperationScopes(tx:Prisma.TransactionClient,op:FinancialOperation){
 const p=op.payload as {hostId?:string;batchId?:string};if(!p.hostId)throw new Error("Missing immutable host scope");
 const items=p.batchId?await tx.payoutItem.findMany({where:{batchId:p.batchId},select:{reservationId:true}}):[];
 const reservations=await tx.reservation.findMany({where:{id:{in:items.map(i=>i.reservationId)}},select:{vehicleId:true}});
 return [...new Set(reservations.map(r=>"vehicle:"+r.vehicleId))].sort().concat("host-finance:"+p.hostId,"operation:"+op.id);
}
export async function lockFinanceOperation(tx:Prisma.TransactionClient,op:FinancialOperation){await assertEventFence(tx);for(const scope of await financeOperationScopes(tx,op))await tx.$queryRaw`SELECT financial_guard_xact(${scope})`;}
export async function lockPayoutReservations(tx:Prisma.TransactionClient,ids:string[],hostId:string){
 const rows=await tx.reservation.findMany({where:{id:{in:ids}},orderBy:[{vehicleId:"asc"},{id:"asc"}],select:{id:true}});
 for(const r of rows)await lockReservation(tx,r.id);
 await tx.$queryRaw`SELECT financial_guard_xact(${"host-finance:"+hostId})`;
}
export async function payoutEligibility(tx:Prisma.TransactionClient,reservationId:string,options:{ignoreBatch?:string;now?:Date}={}){
 const now=options.now??new Date(),reasons:string[]=[];
 try{await requireReservationJurisdiction(tx,reservationId,"PAYOUT");}catch{reasons.push("Jurisdiction is not released for payouts");}
 const accounting=await accountingCompleteness(tx,reservationId);
 if(!accounting.complete)reasons.push("Accounting incomplete: "+accounting.reasons.join("; "));
 const r=await tx.reservation.findUniqueOrThrow({where:{id:reservationId},include:{vehicle:{include:{host:{include:{user:true}}}},trip:true}}),snapshot=await tx.financeSnapshot.findUnique({where:{reservationId}}),earning=await tx.hostEarning.findUnique({where:{reservationId}});
 if(!r.vehicle.host || r.vehicle.host.onboardingStatus!=="APPROVED" || !r.vehicle.host.user.isActive)reasons.push("Host approval or active account required");
 if(!snapshot?.approved)reasons.push("Commission, tax and settlement approval required");
 if(r.status!=="COMPLETED"||!r.trip?.startedAt||!r.trip.endedAt)reasons.push("Completed trip required");
 if(!await tx.tripEvent.count({where:{reservationId,type:"RETURN_REVIEWED"}}))reasons.push("Approved return inspection required");
 const reports=await tx.conditionReport.findMany({where:{reservationId,phase:"POST_TRIP",acceptedAt:{not:null}},include:{photos:true}});
 if(!reports.some(x=>x.submittedByRole==="CUSTOMER"&&x.submittedById===r.customerId)||!reports.some(x=>x.submittedByRole==="HOST")||reports.some(x=>!["EXTERIOR","INTERIOR"].every(category=>x.photos.some(p=>p.category===category))))reasons.push("Accepted return evidence required");
 try{await assertReturnFinancialAuthority(tx,reservationId);}catch{reasons.push("Financial or return review unresolved");}
 if(await tx.providerDispute.count({where:{reservationId,active:true}}))reasons.push("Stripe chargeback or dispute active");
 if(await tx.financeIssue.count({where:{OR:[{reservationId},{hostId:null,reservationId:null,kind:{in:["LEDGER_IMBALANCE","UNMATCHED_PROVIDER_OBJECT"]}},...(r.vehicle.hostId?[{hostId:r.vehicle.hostId,reservationId:null}]:[])],status:{not:"RESOLVED"}}}))reasons.push("Financial reconciliation unresolved");
 if(await tx.serviceCase.count({where:{reservationId,OR:[{state:{not:"CLOSED"}},{legalHold:true},{securityHold:true}]}})||await tx.tripReview.count({where:{reservationId,legalHold:true}})||await tx.conversation.count({where:{reservationId,legalHold:true}})||await tx.privacyDeletion.count({where:{userId:{in:[r.customerId,r.vehicle.host?.userId??""]},state:"RETAINED_LEGAL_REVIEW"}}))reasons.push("Case, legal or security hold");
 const heldFiles=await tx.$queryRaw<Array<{id:string}>>`SELECT f.id FROM "CollaborationFile" f LEFT JOIN "Conversation" c ON c.id=f."conversationId" LEFT JOIN "ServiceCase" s ON s.id=f."caseId" WHERE f."legalHold"=true AND (c."reservationId"=${reservationId} OR s."reservationId"=${reservationId}) LIMIT 1`;
 if(heldFiles.length)reasons.push("Financial evidence legal hold");
 if(earning&&await tx.payoutItem.count({where:{earningId:earning.id,active:true,...(options.ignoreBatch?{batchId:{not:options.ignoreBatch}}:{})}}))reasons.push("Earnings already reserved in a payout batch");
 const account=r.vehicle.hostId?await tx.connectAccount.findUnique({where:{hostId:r.vehicle.hostId}}):null;
 if(!account?.active||!account.accountId||!account.payoutsEnabled||!account.detailsSubmitted||account.verificationStatus!=="VERIFIED"||!account.synchronizedAt||account.synchronizedAt<new Date(now.getTime()-3600000))reasons.push("Stripe account requires action or synchronization");
 const delay=Number((snapshot?.settlement as {delayDays?:number}|undefined)?.delayDays??365),availableAt=r.trip?.endedAt?new Date(r.trip.endedAt.getTime()+delay*86400000):null;
 if(!availableAt||availableAt>now)reasons.push("Settlement delay has not elapsed");
 const amountCents=earning?Math.max(0,earning.netCents-earning.refundedCents+earning.adjustmentCents):0;
 if(amountCents<=0)reasons.push("No positive available earnings");
 const minimumCents=Number((snapshot?.settlement as {minimumCents?:number}|undefined)?.minimumCents??Number.MAX_SAFE_INTEGER);
 return {eligible:reasons.length===0,reasons,amountCents,minimumCents,availableAt,earning,hostId:r.vehicle.hostId,account};
}
export function requireFinanceSandbox(){if(process.env.FINANCE_SANDBOX_ENABLED!=="true"||!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))throw new OperationPendingError("Connect test mode must be explicitly enabled; live payouts are disabled");}
export async function assertFinanceDispatch(tx:Prisma.TransactionClient,op:FinancialOperation){
 requireFinanceSandbox();const p=op.payload as {hostId:string;batchId?:string;accountId?:string;amount?:number;reversalId?:string;transferId?:string;currency?:string};
 const host=await tx.hostProfile.findUniqueOrThrow({where:{id:p.hostId},include:{user:true}});
 if(op.kind!=="FINANCE_REVERSAL"&&(host.onboardingStatus!=="APPROVED"||!host.user.isActive))throw new OperationPendingError("Host is not eligible for new money movement");
 const account=await tx.connectAccount.findUniqueOrThrow({where:{hostId:p.hostId}});
 if(op.kind!=="FINANCE_REVERSAL"&&!account.active)throw new OperationPendingError("Connect account deactivated");
 if(op.kind==="FINANCE_CONNECT")return;
 if(!p.batchId||p.accountId!==account.accountId)throw new Error("Immutable destination mismatch");
 const batch=await tx.payoutBatch.findUniqueOrThrow({where:{id:p.batchId}});
 if(batch.hostId!==p.hostId||batch.accountId!==p.accountId||batch.currency!==p.currency)throw new Error("Batch ownership mismatch");
 if(op.kind==="FINANCE_REVERSAL"){
  const movement=await bankMovement(tx,batch.id);
  if(!movement.complete){await recordBankMovementHold(tx,batch.id,movement.reasons);throw new OperationPendingError("Bank movement incomplete: "+movement.reasons.join("; "));}
  const reversal=await tx.payoutReversal.findUniqueOrThrow({where:{id:p.reversalId}});
  if(movement.availableCents<batch.reversalReservedCents||movement.availableCents<reversal.amountCents)throw new OperationPendingError("Insufficient projected Connect funds; retain host receivable");
  if(!batch.transferId||p.transferId!==batch.transferId||reversal.batchId!==batch.id||reversal.operationId!==op.id||reversal.amountCents!==p.amount||batch.reversalReservedCents<reversal.amountCents)throw new Error("Reversal not atomically reserved");return;
 }
 if(!account.payoutsEnabled||account.verificationStatus!=="VERIFIED")throw new OperationPendingError("Stripe payouts disabled");
 if(op.kind==="FINANCE_PAYOUT"){
  const movement=await bankMovement(tx,batch.id);
  if(!movement.complete||movement.paidCents){await recordBankMovementHold(tx,batch.id,movement.reasons.length?movement.reasons:["Bank funds already paid"]);throw new OperationPendingError("Bank movement incomplete or already paid");}
 }
 const payable=op.kind==="FINANCE_PAYOUT"?batch.transferredCents-batch.reversedCents:batch.amountCents;
 if(p.amount!==payable)throw new Error("Immutable operation amount differs from unreversed batch funds");
 if(op.kind==="FINANCE_PAYOUT" && batch.transferredCents!==batch.amountCents)throw new OperationPendingError("Transfer has not been confirmed");
 const items=await tx.payoutItem.findMany({where:{batchId:batch.id,active:true}});
 if(!items.length||items.reduce((sum,item)=>sum+item.amountCents,0)!==batch.amountCents)throw new Error("Frozen batch items do not cover the immutable amount");
 if(batch.reversalReservedCents)throw new OperationPendingError("Pending transfer recovery blocks new payout movement");
 let eligibleTotal=0;
 for(const item of items){
  const result=await payoutEligibility(tx,item.reservationId,{ignoreBatch:batch.id});
  if(!result.eligible||(op.kind==="FINANCE_TRANSFER"?item.amountCents!==result.amountCents:item.amountCents<result.amountCents)){
   await financeIssue(tx,{key:"accounting-dispatch:"+batch.id,kind:"ACCOUNTING_INCOMPLETE",reservationId:item.reservationId,hostId:batch.hostId,reason:"Accounting incomplete or batch changed: "+result.reasons.join("; "),evidence:{batchId:batch.id}});
   throw new OperationPendingError("Payout eligibility changed: "+result.reasons.join("; "));
  }
  eligibleTotal+=result.amountCents;
 }
 if(eligibleTotal!==payable)throw new OperationPendingError("Reconciled eligible earnings differ from the provider operation amount");
 const {verifyFinanceDestination}=await import("@/lib/finance-provider");
 await verifyFinanceDestination(op);
}
