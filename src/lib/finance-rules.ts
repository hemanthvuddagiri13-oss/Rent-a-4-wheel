import { z } from "zod";
import { marketplacePolicyQuote } from "@/lib/marketplace-pricing";
import type { Prisma, Vehicle } from "@prisma/client";
import { fingerprint,json } from "@/lib/financial-operations";
import { type PricingBreakdown } from "@/lib/pricing";
import { MarketplaceError } from "@/lib/marketplace";
import { financeAdmin,financeStepUp } from "@/lib/finance-access";
import { prisma } from "@/lib/prisma";

const cents=z.coerce.number().int().min(0).max(100000000),bps=z.coerce.number().int().min(0).max(10000);
export const commissionSchema=z.object({basisPoints:bps.default(0),fixedCents:cents.default(0),minimumCents:cents.default(0),maximumCents:cents.default(100000000),hostDiscountBps:bps.default(0)}).refine(x=>x.maximumCents>=x.minimumCents,"Maximum must cover minimum");
export const taxSchema=z.object({jurisdiction:z.string().min(2).max(120),rentalBps:bps,feeBps:bps.default(0),extrasTaxable:z.boolean().default(true),exemptionsAllowed:z.boolean().default(false),provider:z.enum(["CONFIGURED","EXTERNAL"]).default("CONFIGURED")});
export const payoutSchema=z.object({delayDays:z.coerce.number().int().min(0).max(365),minimumCents:cents.min(1),allowedSchedules:z.array(z.enum(["MANUAL","WEEKLY","TWICE_MONTHLY","MONTHLY"])).min(1),hostMaySelect:z.boolean().default(false),timezone:z.string().refine(v=>{try{new Intl.DateTimeFormat("en",{timeZone:v});return true;}catch{return false;}})});
export const lossSchema=z.object({refundHostBps:bps,chargebackHostBps:bps,reverseTransfers:z.boolean().default(false)});
export type FinanceTerms={commission:Record<string,unknown>;tax:Record<string,unknown>;settlement:Record<string,unknown>;amounts:{guestServiceCents?:number;protectionCents?:number;guestProcessingCents?:number;hostProcessingCents?:number;platformProcessingCents?:number;riskReserveCents?:number;depositCents?:number;extrasCents?:number;discountCents?:number;grossCents:number;hostDiscountCents:number;platformDiscountCents:number;commissionCents:number;hostNetCents:number;rentalTaxCents:number;feeTaxCents:number;feesCents:number;totalCents:number};approved:boolean};
export const roundBps=(amount:number,rate:number)=>Number((BigInt(amount)*BigInt(rate)+BigInt(5000))/BigInt(10000));
export async function selectedRule(tx:Prisma.TransactionClient,kind:string,scopes:Array<{scope:string;scopeId:string}>,now=new Date()){
 for(const scope of scopes){const r=await tx.financeRule.findFirst({where:{kind,...scope,approvedAt:{not:null},effectiveAt:{lte:now},OR:[{endsAt:null},{endsAt:{gt:now}}]},orderBy:[{effectiveAt:"desc"},{version:"desc"}]});if(r)return r;}
 return null;
}
export async function financeQuote(tx:Prisma.TransactionClient,vehicle:Vehicle,base:PricingBreakdown,customerId?:string):Promise<{breakdown:PricingBreakdown;terms:FinanceTerms}> {
 const marketplace = await marketplacePolicyQuote(tx,vehicle,base);
 if(marketplace)return marketplace;
 const scopes=[{scope:"VEHICLE",scopeId:vehicle.id},...(vehicle.hostId?[{scope:"HOST",scopeId:vehicle.hostId}]:[]),{scope:"CATEGORY",scopeId:vehicle.category},{scope:"DEFAULT",scopeId:"*"}];
 const commission=await selectedRule(tx,"COMMISSION",scopes),tax=await selectedRule(tx,"TAX",[{scope:"JURISDICTION",scopeId:vehicle.location}]),settlement=await selectedRule(tx,"PAYOUT",scopes),loss=await selectedRule(tx,"LOSS",scopes);
 const c=commissionSchema.parse(commission?.config??{}),t=tax?taxSchema.parse(tax.config):null;
 const gross=base.subtotalCents+base.extrasCents,hostDiscount=roundBps(base.discountCents,c.hostDiscountBps),commissionCents=Math.min(gross-hostDiscount,c.maximumCents,Math.max(c.minimumCents,roundBps(gross-hostDiscount,c.basisPoints)));
 const exempt=Boolean(t?.exemptionsAllowed&&customerId&&await tx.taxExemption.count({where:{customerId,jurisdiction:t.jurisdiction,expiresAt:{gt:new Date()}}}));
 const rentalTax=t&&t.provider==="CONFIGURED"?(exempt?0:roundBps(Math.max(0,base.subtotalCents+(t.extrasTaxable?base.extrasCents:0)-base.discountCents),t.rentalBps)):base.taxCents;
 const fees=c.fixedCents,feeTax=t&&!exempt?roundBps(fees,t.feeBps):0;
 const breakdown={...base,feesCents:fees,taxCents:rentalTax+feeTax,totalCents:gross-base.discountCents+fees+rentalTax+feeTax};
 return {breakdown,terms:{commission:{ruleId:commission?.id??null,version:commission?.version??0,...c},tax:{ruleId:tax?.id??null,version:tax?.version??0,...(t??{jurisdiction:vehicle.location,warning:"NOT TAX-APPROVED — PROFESSIONAL REVIEW REQUIRED"}),exempt},settlement:{ruleId:settlement?.id??null,...(settlement?.config as object??{}),lossRuleId:loss?.id??null,loss:loss?.config??null},amounts:{grossCents:gross,hostDiscountCents:hostDiscount,platformDiscountCents:base.discountCents-hostDiscount,commissionCents,hostNetCents:gross-hostDiscount-commissionCents,rentalTaxCents:rentalTax,feeTaxCents:feeTax,feesCents:fees,totalCents:breakdown.totalCents},approved:Boolean(commission&&tax&&t?.provider==="CONFIGURED"&&settlement&&loss)}};
}
export async function freezeFinance(tx:Prisma.TransactionClient,id:string) {
 const prior=await tx.financeSnapshot.findUnique({where:{reservationId:id}});if(prior)return prior;
 const r=await tx.reservation.findUniqueOrThrow({where:{id},include:{vehicle:true}}),quote=await tx.financeQuote.findUnique({where:{reservationId:id}});
 // Legacy bookings are recorded exactly as charged, but never retroactively
 // approved for host movement using today's business/tax policy.
 const terms=quote?.terms as FinanceTerms|undefined;
 const legacy:FinanceTerms={commission:{legacy:true},tax:{legacy:true,warning:"NOT TAX-APPROVED — PROFESSIONAL REVIEW REQUIRED"},settlement:{legacy:true},amounts:{grossCents:r.subtotalCents+r.extrasCents,hostDiscountCents:r.discountCents,platformDiscountCents:0,commissionCents:0,hostNetCents:r.subtotalCents+r.extrasCents-r.discountCents,rentalTaxCents:r.taxCents,feeTaxCents:0,feesCents:r.feesCents,totalCents:r.totalCents},approved:false};
 const value=terms??legacy;if(value.amounts.totalCents!==r.totalCents)throw new MarketplaceError("Frozen price does not match checkout.",409);
 return tx.financeSnapshot.create({data:{reservationId:id,hostId:r.vehicle.hostId,currency:"usd",commission:json(value.commission),tax:json(value.tax),settlement:json(value.settlement),amounts:json(value.amounts),approved:value.approved,contentHash:fingerprint(value)}});
}
export async function saveFinanceRule(userId:string,input:unknown){
 const d=z.object({kind:z.enum(["COMMISSION","TAX","PAYOUT","LOSS"]),scope:z.enum(["DEFAULT","HOST","VEHICLE","CATEGORY","JURISDICTION"]),scopeId:z.string().min(1).max(150),effectiveAt:z.string().datetime(),endsAt:z.string().datetime().optional(),config:z.unknown(),approve:z.boolean().default(false),stepUpCode:z.string().default("")}).parse(input);
 const config=(d.kind==="COMMISSION"?commissionSchema:d.kind==="TAX"?taxSchema:d.kind==="PAYOUT"?payoutSchema:lossSchema).parse(d.config);
 if(d.approve&&d.kind==="TAX"&&(config as {provider:string}).provider==="EXTERNAL")throw new MarketplaceError("Configure and verify an external tax provider before approving its rules.",409);
 if(d.scope==="DEFAULT"&&d.scopeId!=="*")throw new MarketplaceError("Default rules use scope ID *.");
 if(d.kind!=="TAX"&&d.scope==="JURISDICTION")throw new MarketplaceError("Jurisdiction scope is reserved for tax rules.");
 if(d.endsAt&&new Date(d.endsAt)<=new Date(d.effectiveAt))throw new MarketplaceError("End must follow effective date.");
 if(d.kind==="TAX"&&(d.scope!=="JURISDICTION"||(config as {jurisdiction:string}).jurisdiction!==d.scopeId))throw new MarketplaceError("Tax rules must match an explicit jurisdiction.");
 return prisma.$transaction(async tx=>{const actor=await financeAdmin(tx,userId);if(actor.role==="FINANCE_AGENT")throw new MarketplaceError("Administrator required.",403);await tx.$queryRaw`SELECT financial_guard_xact(${"finance-rule:"+d.kind+":"+d.scope+":"+d.scopeId})`;if(d.approve)await financeStepUp(tx,userId,d.stepUpCode);const last=await tx.financeRule.findFirst({where:{kind:d.kind,scope:d.scope,scopeId:d.scopeId},orderBy:{version:"desc"}});const row=await tx.financeRule.create({data:{kind:d.kind,scope:d.scope,scopeId:d.scopeId,version:(last?.version??0)+1,config:json(config),effectiveAt:new Date(d.effectiveAt),endsAt:d.endsAt?new Date(d.endsAt):null,createdById:userId,approvedAt:d.approve?new Date():null,approvedById:d.approve?userId:null}});await tx.auditLog.create({data:{actorId:userId,action:"finance.rule.version",entityType:"FinanceRule",entityId:row.id,metadata:{approved:d.approve,version:row.version}}});return{id:row.id};});
}

// A future external provider implements this contract; unconfigured external
// calculations cannot become approved snapshots or release host money.
export interface TaxProvider { quote(input:{jurisdiction:string;currency:string;rentalCents:number;feeCents:number}):Promise<{providerId:string;rentalTaxCents:number;feeTaxCents:number;version:string}>; }

