import { afterAll, expect, it } from "vitest";
import { calculateMarketplacePrice, marketplacePricingSchema } from "@/lib/marketplace-pricing";
import { marketplaceRefundAllocation } from "@/lib/marketplace-refund-allocation";
import { financeQuote, freezeFinance } from "@/lib/finance-rules";
import { accountReservation } from "@/lib/finance-ledger";
import { withReservationLock } from "@/lib/financial-locks";
import { fingerprint,json } from "@/lib/financial-operations";
import { prisma,createTestCustomer,createTestHost,createTestVehicle } from "./helpers/factories";
import { fixtureJurisdiction } from "./helpers/jurisdiction-fixture";
import type { PricingBreakdown } from "@/lib/pricing";
const fee={basisPoints:0,flatCents:0,minimumCents:0,maximumCents:100000};
const config=marketplacePricingSchema.parse({currency:"usd",hostCommission:{...fee,basisPoints:1000},guestService:{...fee,basisPoints:500},subscriptions:[{plan:"SAMPLE",monthlyCents:999,commissionReductionBps:100}],volumeTiers:[{completedTrips:10,commissionReductionBps:100}],jurisdictionAdjustment:{hostCommissionBps:0,guestServiceFlatCents:0},protection:{...fee,flatCents:700},processing:{fee:{...fee,flatCents:300},allocation:"HOST"},taxes:{basisPoints:800,extrasTaxable:true,guestServiceTaxable:true,protectionTaxable:false,processingTaxable:false},riskReserve:{...fee,flatCents:200},promotions:{hostShareBps:5000},settlement:{delayDays:7,refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}});
const base:PricingBreakdown={rateType:"DAILY",rateAmountCents:10000,units:1,days:1,subtotalCents:10000,extrasCents:2000,extraLineItems:[],discountCents:1000,taxCents:0,feesCents:0,totalCents:11000,depositCents:30000};
const facts={completedTrips:0,subscriptionPlan:null};
afterAll(()=>prisma.$disconnect());
it("separates sample fees, protection, tax, processing, risk reserve, discount and host entitlement in integer cents",()=>{
 const result=calculateMarketplacePrice(base,config,facts);
 expect(result.amounts).toMatchObject({hostNetCents:9850,commissionCents:1150,guestServiceCents:550,protectionCents:700,hostProcessingCents:300,riskReserveCents:200,rentalTaxCents:880,feeTaxCents:44,totalCents:13174,depositCents:30000,platformDiscountCents:500});
 expect(result.breakdown.marketplace?.approval).toBe("SAMPLE_UNAPPROVED");
 expect(result.breakdown.totalCents).toBe(13174); // Deposit is an authorization, not a charge or revenue.
});
it("uses subscription and volume facts, explicit jurisdiction adjustments and fee caps without silently billing subscriptions",()=>{
 const adjusted={...config,jurisdictionAdjustment:{hostCommissionBps:50,guestServiceFlatCents:100},guestService:{...fee,basisPoints:500,minimumCents:200,maximumCents:600}};
 const result=calculateMarketplacePrice(base,adjusted,{completedTrips:10,subscriptionPlan:"SAMPLE"});
 expect(result.facts.appliedCommissionBps).toBe(850);expect(result.amounts.commissionCents).toBe(978);expect(result.amounts.guestServiceCents).toBe(600);expect(result.facts.subscriptionMonthlyCents).toBe(999);
 expect(result.amounts.totalCents).toBe(13228);
 expect(()=>calculateMarketplacePrice(base,{...config,hostCommission:{...fee,flatCents:99999}},facts)).toThrow("HOST_EARNINGS");
 expect(()=>calculateMarketplacePrice({...base,discountCents:12001},config,facts)).toThrow("DISCOUNT");
});
it("allocates every partial-refund cent cumulatively and fully reverses sample fees without treating processing liabilities as revenue",()=>{
 const a=calculateMarketplacePrice(base,config,facts).amounts;
 let previous={tax:0,protection:0,reserve:0,host:0,platformFees:0,platformCost:0,discount:0};
 for(let cash=1;cash<=a.totalCents;cash++){
  const next=marketplaceRefundAllocation(a,cash,a.totalCents,10000,a.hostNetCents);
  for(const key of Object.keys(previous) as Array<keyof typeof previous>)expect(next[key]).toBeGreaterThanOrEqual(previous[key]);
  expect(next.tax+next.protection+next.reserve+next.host+next.platformFees+next.platformCost-next.discount).toBe(cash);previous=next;
 }
 expect(previous).toEqual({tax:924,protection:700,reserve:200,host:9850,platformFees:1700,platformCost:300,discount:500});
});
it("freezes actual database policy and calculation, preserves them after new policy, and posts balanced liabilities and two partial refunds",async()=>{
 await fixtureJurisdiction(prisma,"WA");const host=await createTestHost(),customer=await createTestCustomer(),vehicle=await createTestVehicle({hostId:host.hostProfile.id,jurisdictionCode:"WA"});
 const reviewer=await prisma.user.findUniqueOrThrow({where:{email:"jurisdiction-reviewer@fixtures.invalid"}});
 const previous=await prisma.marketplacePricingPolicy.findFirst({where:{jurisdictionCode:"WA"},orderBy:{version:"desc"}});
 const policy=await prisma.marketplacePricingPolicy.create({data:{jurisdictionCode:"WA",version:(previous?.version??0)+1,status:"STAGING_READY",config:json(config),contentHash:fingerprint(config),reviewedById:reviewer.id,reviewedAt:new Date(),effectiveAt:new Date(0)}});
 const quote=await prisma.$transaction(tx=>financeQuote(tx,vehicle,base,customer.id));expect(quote.terms.approved).toBe(false);
 const r=await prisma.reservation.create({data:{confirmationNumber:"NATIONAL-"+crypto.randomUUID(),vehicleId:vehicle.id,customerId:customer.id,jurisdictionCode:"WA",jurisdictionSnapshot:{fixture:true},pickupAt:new Date("2035-01-01"),returnAt:new Date("2035-01-02"),rateType:"DAILY",rateAmountCents:10000,units:1,subtotalCents:10000,extrasCents:2000,discountCents:1000,feesCents:1250,taxCents:924,totalCents:13174,status:"AWAITING_PAYMENT"}});
 await prisma.financeQuote.create({data:{reservationId:r.id,terms:json(quote.terms)}});
 const frozen=await withReservationLock(r.id,tx=>freezeFinance(tx,r.id));
 await expect(prisma.marketplacePricingPolicy.update({where:{id:policy.id},data:{config:json({...config,guestService:fee})}})).rejects.toThrow("immutable");
 await prisma.marketplacePricingPolicy.create({data:{jurisdictionCode:"WA",version:policy.version+1,status:"STAGING_READY",config:json({...config,guestService:fee}),contentHash:fingerprint({...config,guestService:fee}),reviewedById:reviewer.id,reviewedAt:new Date(),effectiveAt:new Date(0)}});
 expect((await withReservationLock(r.id,tx=>freezeFinance(tx,r.id))).contentHash).toBe(frozen.contentHash);
 await expect(prisma.reservation.update({where:{id:r.id},data:{jurisdictionCode:"TX"}})).rejects.toThrow("immutable");
 const payment=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:r.totalCents,idempotencyKey:"national-"+r.id}});
 await withReservationLock(r.id,tx=>accountReservation(tx,r.id));
 let entries=await prisma.ledgerLine.findMany({where:{journal:{reservationId:r.id}}});expect(entries.some(e=>e.account.endsWith("REVENUE"))).toBe(false);
 expect(entries.find(e=>e.account==="PROTECTION_PAYABLE")?.creditCents).toBe(700);expect(entries.find(e=>e.account==="HOST_PAYABLE")?.creditCents).toBe(9850);
 // Disabling the state leaves financial recovery available and immutable evidence intact.
 await prisma.jurisdiction.update({where:{code:"WA"},data:{mode:"DISABLED"}});
 for(const amountCents of [4000,9174]){await prisma.refund.create({data:{reservationId:r.id,paymentId:payment.id,amountCents,status:"SUCCEEDED",reason:"Controlled sample refund",idempotencyKey:crypto.randomUUID()}});await withReservationLock(r.id,tx=>accountReservation(tx,r.id));}
 await withReservationLock(r.id,tx=>accountReservation(tx,r.id)); // Recovery replay must produce no duplicate journals.
 expect(await prisma.ledgerJournal.count({where:{reservationId:r.id,kind:"REFUND"}})).toBe(2);
 entries=await prisma.ledgerLine.findMany({where:{journal:{reservationId:r.id}}});
 for(const account of ["HOST_PAYABLE","PROTECTION_PAYABLE","HOST_RISK_RESERVE_PAYABLE","TAX_PAYABLE","UNSETTLED_PLATFORM_FEES","PLATFORM_DISCOUNTS"])expect(entries.filter(e=>e.account===account).reduce((n,e)=>n+e.creditCents-e.debitCents,0),account).toBe(0);
 expect((await prisma.hostEarning.findUniqueOrThrow({where:{reservationId:r.id}})).refundedCents).toBe(9850);
 // Immutable financial records intentionally survive in the disposable test database.
});
