import type {Prisma} from "@prisma/client";
import {fingerprint,json} from "@/lib/financial-operations";
import {lossSchema,type FinanceTerms} from "@/lib/finance-rules";
import {emptyRefundAllocation,marketplaceRefundAllocation,type RefundAllocation} from "@/lib/marketplace-refund-allocation";

export const refundAccounts:Record<keyof RefundAllocation,string[]>={tax:["TAX_PAYABLE"],protection:["PROTECTION_PAYABLE"],reserve:["HOST_RISK_RESERVE_PAYABLE"],host:["HOST_PAYABLE","HOST_RECEIVABLE"],platformFees:["UNSETTLED_PLATFORM_FEES"],platformCost:["PLATFORM_REFUND_COST"],discount:["PLATFORM_DISCOUNTS"]};
type Line={account:string;debitCents:number;creditCents:number};
export function postedRefundAllocation(lines:Line[]){const value=emptyRefundAllocation();for(const k of Object.keys(value) as Array<keyof RefundAllocation>)value[k]=lines.filter(l=>refundAccounts[k].includes(l.account)).reduce((n,l)=>n+(k==="discount"?l.creditCents-l.debitCents:l.debitCents-l.creditCents),0);return value;}
function balanced(lines:Line[]){return lines.length>=2&&lines.every(l=>Number.isSafeInteger(l.debitCents)&&Number.isSafeInteger(l.creditCents)&&l.debitCents>=0&&l.creditCents>=0&&!(l.debitCents&&l.creditCents))&&lines.reduce((n,l)=>n+l.debitCents-l.creditCents,0)===0;}

/** Caller holds release -> reservation/financial guards. Historical evidence is
 * supplemental: immutable journal rows and their fingerprints are never edited.
 * Same-timestamp ordering is uncertain; no ordering is invented from mutable IDs.
 */
export async function ensureRefundCompatibility(tx:Prisma.TransactionClient,reservationId:string){
 const snapshot=await tx.financeSnapshot.findUnique({where:{reservationId}});
 if((snapshot?.commission as {engine?:string}|null)?.engine!=="MARKETPLACE_V1")return {valid:true,records:[]};
 const journals=await tx.ledgerJournal.findMany({where:{reservationId},include:{lines:{orderBy:{id:"asc"}}},orderBy:[{createdAt:"asc"},{id:"asc"}]});
 const sequence=journals.filter(j=>j.kind==="REFUND"),historical=sequence.filter(j=>!j.allocationEvidence);
 const records=await tx.refundCompatibilityEvidence.findMany({where:{reservationId},orderBy:{journalId:"asc"}});
 if(!historical.length)return {valid:true,records};
 const payments=await tx.payment.findMany({where:{reservationId,type:"RENTAL",status:"SUCCEEDED"}}),refunds=await tx.refund.findMany({where:{reservationId}}),adjustments=await tx.financeAdjustment.findMany({where:{reservationId,state:"APPROVED"}});
 const rules=lossSchema.safeParse((snapshot!.settlement as {loss?:unknown}).loss),amounts=snapshot!.amounts as FinanceTerms["amounts"];
 const prior=emptyRefundAllocation();let cash=0,valid=true,modernSeen=false;
 for(const j of sequence){
  if(j.allocationEvidence){modernSeen=true;continue;}
  try{
   if(modernSeen||payments.length!==1||!rules.success)throw new Error("MISSING_OR_AMBIGUOUS_PAYMENT_POLICY");
   const payment=payments[0],refund=refunds.find(f=>j.key==="refund:"+f.id),paymentJournal=journals.find(p=>p.key==="payment:"+payment.id);
   if(!refund||refund.paymentId!==payment.id||refund.status!=="SUCCEEDED"||refund.legacyUncertain||refund.stripeRefundId!==j.providerId||j.currency!==payment.currency||snapshot!.currency!==payment.currency||payment.amountCents!==amounts.totalCents||!paymentJournal||!balanced(paymentJournal.lines)||paymentJournal.createdAt>j.createdAt||!balanced(j.lines))throw new Error("MISSING_OR_CONTRADICTORY_SOURCE");
   if(sequence.some(other=>other.id!==j.id&&other.createdAt.getTime()===j.createdAt.getTime()))throw new Error("AMBIGUOUS_JOURNAL_ORDER");
   const allowed=new Set([...Object.values(refundAccounts).flat(),"STRIPE_CLEARING"]);
   if(j.lines.some(l=>!allowed.has(l.account)||l.account!=="STRIPE_CLEARING"&&l.account!=="PLATFORM_DISCOUNTS"&&l.creditCents>0||["STRIPE_CLEARING","PLATFORM_DISCOUNTS"].includes(l.account)&&l.debitCents>0)||j.lines.filter(l=>l.account==="STRIPE_CLEARING").reduce((n,l)=>n+l.creditCents,0)!==refund.amountCents)throw new Error("UNEXPLAINED_JOURNAL_LINES");
   let adjustment=0;const effective=[];
   const hostChanges=journals.filter(x=>x.id!==paymentJournal.id&&x.kind!=="REFUND"&&x.createdAt<=j.createdAt&&x.lines.some(l=>["HOST_PAYABLE","HOST_RECEIVABLE"].includes(l.account)));
   for(const change of hostChanges){
    const a=adjustments.find(a=>a.journalId===change.id);
    if(!a||!a.approvedById||a.approvedById===a.createdById||!["HOST_DEBIT","HOST_CREDIT"].includes(a.kind)||change.key!=="adjustment:"+a.id||change.kind!==a.kind||change.currency!==payment.currency||!balanced(change.lines))throw new Error("UNEXPLAINED_HOST_ADJUSTMENT");
    if(change.createdAt.getTime()===j.createdAt.getTime())throw new Error("AMBIGUOUS_ADJUSTMENT_ORDER");
    const evidence=await tx.financialCase.findUnique({where:{id:a.evidenceId}});
    if(!evidence||evidence.reservationId!==reservationId||evidence.status!=="RESOLVED"||!evidence.resolution||evidence.currency!==payment.currency||evidence.amountCents===null||evidence.amountCents<a.amountCents)throw new Error("MISSING_ADJUSTMENT_APPROVAL_EVIDENCE");
    const net=change.lines.filter(l=>["HOST_PAYABLE","HOST_RECEIVABLE"].includes(l.account)).reduce((n,l)=>n+l.creditCents-l.debitCents,0),expected=a.kind==="HOST_CREDIT"?a.amountCents:-a.amountCents;
    if(net!==expected)throw new Error("CONTRADICTORY_ADJUSTMENT");
    adjustment+=net;effective.push({id:a.id,journalId:change.id,journalHash:change.fingerprint,kind:a.kind,amountCents:a.amountCents,approvedById:a.approvedById,createdById:a.createdById,evidenceId:evidence.id,postedAt:change.createdAt.toISOString()});
   }
   cash+=refund.amountCents;
   const target=marketplaceRefundAllocation(amounts,cash,payment.amountCents,rules.data.refundHostBps,amounts.hostNetCents+adjustment),actual=postedRefundAllocation(j.lines);
   for(const k of Object.keys(prior) as Array<keyof RefundAllocation>)if(actual[k]<0||actual[k]!==target[k]-prior[k])throw new Error("HISTORICAL_ALLOCATION_MISMATCH");
   const inputs={algorithm:"f0255dc-marketplace-v1",snapshotHash:snapshot!.contentHash,amounts,refundHostBps:rules.data.refundHostBps,payment:{id:payment.id,amount:payment.amountCents,currency:payment.currency,journalId:paymentJournal.id,journalHash:paymentJournal.fingerprint},refund:{id:refund.id,amount:refund.amountCents,providerId:refund.stripeRefundId},journal:{id:j.id,hash:j.fingerprint,postedAt:j.createdAt.toISOString(),lines:j.lines.map(l=>({account:l.account,debitCents:l.debitCents,creditCents:l.creditCents}))},adjustments:effective,prior:{...prior},cumulativeCash:cash,delta:actual};
   const evidenceHash=fingerprint({version:1,inputs,openingAllocation:target}),existing=records.find(r=>r.journalId===j.id);
   if(existing){if(existing.version!==1||existing.validationResult!=="VALID_HISTORICAL_V1"||existing.evidenceHash!==evidenceHash||fingerprint(existing.inputs)!==fingerprint(inputs)||fingerprint(existing.openingAllocation)!==fingerprint(target))throw new Error("COMPATIBILITY_EVIDENCE_CHANGED");}
   else records.push(await tx.refundCompatibilityEvidence.create({data:{journalId:j.id,reservationId,refundId:refund.id,paymentId:payment.id,version:1,validationResult:"VALID_HISTORICAL_V1",inputs:json(inputs),openingAllocation:json(target),evidenceHash}}));
   Object.assign(prior,target);
  }catch(error){
   valid=false;
   const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:"HISTORICAL_EVIDENCE_INVALID";
   await tx.financeIssue.upsert({where:{key:"refund-compatibility:"+j.id},create:{key:"refund-compatibility:"+j.id,kind:"REFUND_COMPATIBILITY_REVIEW",reservationId,reason,evidence:{journalId:j.id,required:"Verify historical payment, adjustment approval/order and refund allocation; never edit issued journals"}},update:{status:"OPEN",resolution:null,reason}});
   break;
  }
 }
 if(valid)await tx.financeIssue.updateMany({where:{reservationId,kind:"REFUND_COMPATIBILITY_REVIEW",status:{not:"RESOLVED"}},data:{status:"RESOLVED",resolution:"Unique historical reconstruction verified against supplemental immutable evidence"}});
 return {valid,records:records.sort((a,b)=>a.journalId.localeCompare(b.journalId))};
}
