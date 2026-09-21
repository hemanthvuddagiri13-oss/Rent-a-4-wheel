import type { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { fingerprint, json } from "@/lib/financial-operations";
import { journal } from "@/lib/finance-ledger";
import type { FinanceTerms } from "@/lib/finance-rules";

/** Receipt commits separately from projection: a failed journal never erases it. */
export async function retainProcessingFee(paymentId:string, balance:Stripe.BalanceTransaction) {
  const payment=await prisma.payment.findUniqueOrThrow({where:{id:paymentId}});
  if(payment.status!=="SUCCEEDED"||balance.currency!==payment.currency||balance.amount!==payment.amountCents||![balance.amount,balance.fee,balance.net].every(Number.isSafeInteger)||balance.fee<0||balance.amount-balance.fee!==balance.net)throw new Error("PROVIDER_FEE_EVIDENCE_MISMATCH");
  const data={providerId:balance.id,paymentId,reservationId:payment.reservationId,currency:balance.currency,amountCents:balance.amount,feeCents:balance.fee,netCents:balance.net,evidence:json(balance)};
  // Availability/status may advance on the same balance transaction. Preserve
  // the original full receipt; compare only its immutable monetary identity.
  const hash=fingerprint({providerId:data.providerId,paymentId,reservationId:data.reservationId,currency:data.currency,amountCents:data.amountCents,feeCents:data.feeCents,netCents:data.netCents});
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT financial_guard_xact(${"provider-fee:"+paymentId})`;
    const prior=await tx.providerFeeEvidence.findUnique({where:{paymentId}});
    if(prior){if(prior.fingerprint!==hash)throw new Error("PROVIDER_FEE_EVIDENCE_CHANGED");return prior;}
    return tx.providerFeeEvidence.create({data:{...data,fingerprint:hash}});
  });
}

/** Caller holds reservation guard; capture accrual and settlement are atomic. */
export async function projectProcessingFees(tx:Prisma.TransactionClient,reservationId:string) {
  const rows=await tx.providerFeeEvidence.findMany({where:{reservationId}});
  const snapshot=await tx.financeSnapshot.findUnique({where:{reservationId}});
  for(const row of rows){
    const payment=await tx.payment.findUniqueOrThrow({where:{id:row.paymentId}});
    if(!await tx.ledgerJournal.findUnique({where:{key:"payment:"+payment.id}}))continue;
    const key="stripe-fee:"+row.providerId,prior=await tx.ledgerJournal.findUnique({where:{key}});
    const marketplace=payment.type==="RENTAL"&&(snapshot?.commission as {engine?:string})?.engine==="MARKETPLACE_V1";
    const a=snapshot?.amounts as FinanceTerms["amounts"];
    const estimate=marketplace?(a.hostProcessingCents??0)+(a.guestProcessingCents??0)+(a.platformProcessingCents??0):0;
    if(prior){
      // Retain pre-correction journals; settle their missed accrual explicitly.
      if(marketplace&&!(prior.allocationEvidence as {feeReceipt?:string}|null)?.feeReceipt&&(estimate>0||row.feeCents>0)){
        await journal(tx,{key:"stripe-fee-correction:"+row.providerId,kind:"STRIPE_FEE_CORRECTION",currency:row.currency,reservationId,providerId:row.providerId,description:"Settle frozen processing accrual omitted by legacy fee projection",lines:[{account:"PROCESSING_PAYABLE",debitCents:estimate},{account:"STRIPE_FEE_EXPENSE",creditCents:row.feeCents},{account:"PAYMENT_PROCESSING_EXPENSE",debitCents:Math.max(0,row.feeCents-estimate),creditCents:Math.max(0,estimate-row.feeCents)}]});
      }
      continue;
    }
    if(!row.feeCents&&!estimate)continue;
    await journal(tx,{key,kind:"STRIPE_FEE",currency:row.currency,reservationId,providerId:row.providerId,description:"Provider-confirmed processing liability settlement",allocationEvidence:{feeReceipt:row.providerId,fingerprint:row.fingerprint,estimate},lines:marketplace?[
      {account:"PROCESSING_PAYABLE",debitCents:estimate},
      {account:"PAYMENT_PROCESSING_EXPENSE",debitCents:Math.max(0,row.feeCents-estimate),creditCents:Math.max(0,estimate-row.feeCents)},
      {account:"STRIPE_CLEARING",creditCents:row.feeCents},
    ]:[{account:"STRIPE_FEE_EXPENSE",debitCents:row.feeCents},{account:"STRIPE_CLEARING",creditCents:row.feeCents}]});
  }
}
