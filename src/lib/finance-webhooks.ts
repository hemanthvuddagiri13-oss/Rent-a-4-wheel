import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { financeStripe } from "@/lib/finance-provider";
import { synchronizeConnect,executeFinanceOperation } from "@/lib/payout-operations";
import { withReservationLock,assertEventFence } from "@/lib/financial-locks";
import { financeIssue,journal } from "@/lib/finance-ledger";

export function isFinanceEvent(type:string){return /^(account\.|transfer\.|payout\.|charge\.dispute\.|account.application.deauthorized)/.test(type);}
export function safeFinanceEvent(event:Stripe.Event):Stripe.Event {
 if(!isFinanceEvent(event.type))return event;
 const object=event.data.object as {id:string;object?:string};
 // Recovery retrieves provider state by ID. Never retain account/person/bank
 // payloads or chargeback evidence in the generic event ledger.
 return {id:event.id,type:event.type,object:"event",created:event.created,livemode:event.livemode,api_version:event.api_version,pending_webhooks:0,request:null,...(event.account?{account:event.account}:{}),data:{object:{id:object.id,object:object.object}}} as Stripe.Event;
}
export async function handleFinanceEvent(event:Stripe.Event){
 const object=event.data.object as {id:string};
 if(event.type.startsWith("account.")){
  const a=await prisma.connectAccount.findUnique({where:{accountId:event.account??object.id}});if(!a)return;
  if(event.type==="account.application.deauthorized") {await prisma.$transaction(async tx=>{await assertEventFence(tx);await tx.$queryRaw`SELECT financial_guard_xact(${"host-finance:"+a.hostId})`;await tx.connectAccount.update({where:{hostId:a.hostId},data:{active:false,payoutsEnabled:false,verificationStatus:"DEACTIVATED"}});});return;}
  await synchronizeConnect(a.hostId);return;
 }
 if(event.type.startsWith("charge.dispute.")){
  const provider=financeStripe(),d=await provider.disputes.retrieve(object.id),chargeId=typeof d.charge==="string"?d.charge:d.charge.id;
  const charge=await provider.charges.retrieve(chargeId),intentId=typeof charge.payment_intent==="string"?charge.payment_intent:charge.payment_intent?.id;
  const payment=intentId?await prisma.payment.findUnique({where:{stripePaymentIntentId:intentId}}):null;
  if(!payment){await financeIssue(prisma,{key:"unmatched-dispute:"+d.id,kind:"UNMATCHED_PROVIDER_OBJECT",reason:"Stripe dispute has no owned internal payment",evidence:{providerId:d.id}});return;}
  await withReservationLock(payment.reservationId,async tx=>{
   const active=!["won","lost","warning_closed"].includes(d.status);
   await tx.providerDispute.upsert({where:{id:d.id},create:{id:d.id,reservationId:payment.reservationId,chargeId,currency:d.currency,amountCents:d.amount,status:d.status,active},update:{status:d.status,active,checkedAt:new Date()}});
   if(d.status==="lost"){
    await journal(tx,{key:"chargeback:"+d.id,kind:"CHARGEBACK",currency:d.currency,reservationId:payment.reservationId,providerId:d.id,description:"Lost Stripe dispute pending approved loss allocation",lines:[{account:"CHARGEBACK_SUSPENSE",debitCents:d.amount},{account:"STRIPE_CLEARING",creditCents:d.amount}]});
    await financeIssue(tx,{key:"chargeback-allocation:"+d.id,kind:"CHARGEBACK_ALLOCATION",reservationId:payment.reservationId,reason:"Loss allocation requires approved policy and independent financial authorization",evidence:{providerId:d.id,amountCents:d.amount,currency:d.currency}});
   }
   await tx.auditLog.create({data:{action:"finance.dispute.synchronized",entityType:"ProviderDispute",entityId:d.id,metadata:{status:d.status,active}}});
  });return;
 }
 const owner=await prisma.financeObject.findUnique({where:{providerId:object.id}});
 if(owner){const op=await prisma.financialOperation.findUniqueOrThrow({where:{id:owner.operationId}});if(event.account&&event.account!==(op.payload as {accountId?:string}).accountId)throw new Error("Connect event account mismatch");await executeFinanceOperation(op);}
 else await financeIssue(prisma,{key:"unmatched-finance:"+object.id,kind:"UNMATCHED_PROVIDER_OBJECT",reason:"Provider object arrived before an owned operation was reconciled",evidence:{providerId:object.id}});
}
