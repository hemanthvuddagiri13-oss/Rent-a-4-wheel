import { createHash } from "node:crypto";
import { renderFinancePdf } from "@/lib/finance-pdf";
import { prisma } from "@/lib/prisma";
import { marketplaceActor,MarketplaceError } from "@/lib/marketplace";
import { financeAdmin,financeHost } from "@/lib/finance-access";
import { fingerprint,json } from "@/lib/financial-operations";
import { lockReservation } from "@/lib/financial-locks";
import { accountReservation } from "@/lib/finance-ledger";

const customerKinds=["PAYMENT_RECEIPT","REFUND_RECEIPT","RENTAL_INVOICE","FINAL_TRIP_STATEMENT"];
const hostKinds=["EARNINGS_STATEMENT","PAYOUT_STATEMENT","ADJUSTMENT_STATEMENT","MONTHLY_SUMMARY","YEARLY_SUMMARY"];
const platformKinds=["COMMISSION_REPORT","TAX_REPORT","LIABILITY_REPORT","RECONCILIATION_REPORT"];
export const documentKinds=[...customerKinds,...hostKinds,...platformKinds];
export async function issueFinanceDocument(userId:string,input:{kind:string;reservationId?:string;batchId?:string;period?:string;newVersion?:boolean}){
 if(!documentKinds.includes(input.kind))throw new MarketplaceError("Unknown document type.");
 return prisma.$transaction(async tx=>{
  const actor=await marketplaceActor(tx,userId);let hostId:string|null=null,customerId:string|null=null,reservationId:string|null=null;const snapshot:Record<string,unknown>={kind:input.kind,templateVersion:"finance-v1",currency:"usd",timezone:"America/Chicago"};
  if(customerKinds.includes(input.kind)||input.kind==="EARNINGS_STATEMENT"||input.kind==="ADJUSTMENT_STATEMENT"){
   if(!input.reservationId)throw new MarketplaceError("Select a reservation.");await lockReservation(tx,input.reservationId);const r=await tx.reservation.findUniqueOrThrow({where:{id:input.reservationId},include:{vehicle:true,payments:true,refunds:true}});reservationId=r.id;customerId=r.customerId;hostId=r.vehicle.hostId;
   if(customerKinds.includes(input.kind)){if(userId!==r.customerId)await financeAdmin(tx,userId);}else if(!["FINANCE_AGENT","ADMIN","SUPER_ADMIN"].includes(actor.role))await financeHost(tx,userId,hostId??"invalid");
   if(input.kind==="PAYMENT_RECEIPT"&&!r.payments.some(p=>p.type==="RENTAL"&&p.status==="SUCCEEDED"))throw new MarketplaceError("A succeeded rental payment is required for a receipt.",409);
   if(input.kind==="REFUND_RECEIPT"&&!r.refunds.some(f=>f.status==="SUCCEEDED"))throw new MarketplaceError("A succeeded refund is required for a receipt.",409);
   if(input.kind==="FINAL_TRIP_STATEMENT"&&r.status!=="COMPLETED")throw new MarketplaceError("Final statements require a completed trip.",409);
   await accountReservation(tx,r.id);const frozen=await tx.financeSnapshot.findUniqueOrThrow({where:{reservationId:r.id}});
   Object.assign(snapshot,{confirmation:r.confirmationNumber,timezone:r.bookingTimezone,amounts:customerKinds.includes(input.kind)?{rentalSubtotalCents:r.subtotalCents,extrasCents:r.extrasCents,discountCents:r.discountCents,taxCents:r.taxCents,serviceFeeCents:r.feesCents,totalCents:r.totalCents}:frozen.amounts,payments:customerKinds.includes(input.kind)?r.payments.map(p=>({type:p.type,status:p.status,amountCents:p.amountCents,currency:p.currency})):undefined,refunds:r.refunds.map(f=>({amountCents:f.amountCents,status:f.status})),taxApproval:frozen.approved?"Configured tax snapshot":"NOT TAX-APPROVED - PROFESSIONAL REVIEW REQUIRED"});
  }else if(input.kind==="PAYOUT_STATEMENT"){
   const b=await tx.payoutBatch.findUniqueOrThrow({where:{id:input.batchId}});hostId=b.hostId;if(!["FINANCE_AGENT","ADMIN","SUPER_ADMIN"].includes(actor.role))await financeHost(tx,userId,hostId);Object.assign(snapshot,{batchId:b.id,amountCents:b.amountCents,currency:b.currency,status:b.state,paidCents:b.paidCents,reversedCents:b.reversedCents,issuedFor:b.createdAt.toISOString()});
  }else if(hostKinds.includes(input.kind)){
   const context=await financeHost(tx,userId);hostId=context.host.id;const period=input.period??String(new Date().getUTCFullYear());if(!/^\d{4}(-\d{2})?$/.test(period))throw new MarketplaceError("Use YYYY or YYYY-MM.");const start=new Date(period.length===4?period+"-01-01T00:00:00Z":period+"-01T00:00:00Z"),end=new Date(start);if(period.length===4)end.setUTCFullYear(end.getUTCFullYear()+1);else end.setUTCMonth(end.getUTCMonth()+1);const entries=await tx.hostEarning.findMany({where:{hostId,createdAt:{gte:start,lt:end}},select:{reservationId:true,grossCents:true,commissionCents:true,netCents:true,refundedCents:true,adjustmentCents:true,currency:true}});Object.assign(snapshot,{period,earnings:entries,taxNotice:"Final 1099 eligibility and filing require tax-professional/provider confirmation."});
  }else{await financeAdmin(tx,userId);const totals=await tx.$queryRaw<Array<{account:string;currency:string;debit:string;credit:string}>>`SELECT l.account,j.currency,sum(l."debitCents")::text debit,sum(l."creditCents")::text credit FROM "LedgerLine" l JOIN "LedgerJournal" j ON j.id=l."journalId" GROUP BY l.account,j.currency ORDER BY j.currency,l.account`;Object.assign(snapshot,{totals,warning:"NOT TAX-APPROVED - PROFESSIONAL REVIEW REQUIRED",issues:input.kind==="RECONCILIATION_REPORT"?await tx.financeIssue.findMany({select:{id:true,kind:true,status:true,reason:true},take:1000}):undefined});}
  const scope=`${input.kind}:${reservationId??input.batchId??hostId??"platform"}:${input.period??"current"}`;await tx.$queryRaw`SELECT financial_guard_xact(${"statement:"+scope})`;
  const previous=await tx.financeDocument.findFirst({where:{key:{startsWith:scope+":"}},orderBy:{version:"desc"}});if(previous&&!input.newVersion)return{id:previous.id};
  const version=(previous?.version??0)+1;Object.assign(snapshot,{version,snapshotHash:fingerprint(snapshot)});const pdf=await renderFinancePdf(snapshot),contentHash=createHash("sha256").update(pdf).digest("hex");
  const row=await tx.financeDocument.create({data:{key:scope+":"+version,kind:input.kind,reservationId,hostId,customerId,version,templateVersion:"finance-v1",currency:String(snapshot.currency),timezone:String(snapshot.timezone),snapshot:json(snapshot),contentHash,pdf}});await tx.auditLog.create({data:{actorId:userId,action:"finance.statement.issued",entityType:"FinanceDocument",entityId:row.id,metadata:{version,contentHash}}});return{id:row.id};
 },{timeout:20000});
}
export async function readFinanceDocument(userId:string,id:string){const actor=await marketplaceActor(prisma,userId),d=await prisma.financeDocument.findUniqueOrThrow({where:{id}});if(customerKinds.includes(d.kind)){if(d.customerId!==userId)await financeAdmin(prisma,userId);}else if(d.hostId){if(!["FINANCE_AGENT","ADMIN","SUPER_ADMIN"].includes(actor.role))await financeHost(prisma,userId,d.hostId);}else await financeAdmin(prisma,userId);if(createHash("sha256").update(d.pdf).digest("hex")!==d.contentHash)throw new Error("Issued PDF integrity failure");await prisma.auditLog.create({data:{actorId:userId,action:"finance.statement.download",entityType:"FinanceDocument",entityId:id}});return d;}
