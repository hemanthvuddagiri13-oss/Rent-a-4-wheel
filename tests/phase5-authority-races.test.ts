import {afterAll,afterEach,it,expect,vi} from "vitest";
import {PrismaClient,type LegalDocumentType} from "@prisma/client";
import {createHash,randomUUID} from "node:crypto";
import type Stripe from "stripe";
import {prisma,createTestCustomer,createTestHost,createTestVehicle,createTestReservation} from "./helpers/factories";
import {barrier} from "./helpers/barrier";
const provider=vi.hoisted(()=>({create:vi.fn(),retrieve:vi.fn(),cancel:vi.fn(),refund:vi.fn(),refundRead:vi.fn()}));
vi.mock("@/lib/stripe",()=>({stripe:{paymentIntents:{create:provider.create,retrieve:provider.retrieve,cancel:provider.cancel},refunds:{create:provider.refund,retrieve:provider.refundRead}}}));
vi.mock("@/lib/production-config",()=>({productionConfiguration:()=>({ready:true,issues:[]})}));
import {POLICY_KINDS} from "@/lib/release-control";
import {recordAgreementAcceptance} from "@/lib/agreements";
import {hostCommand} from "@/lib/marketplace";
import {confirmAfterRentalPaymentSuccess,settleTerminatedReservation} from "@/lib/stripe-webhook-handlers";
import * as deposits from "@/lib/deposit-authorization";
const other=new PrismaClient();
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const fn of Object.values(provider))fn.mockReset();});
afterAll(async()=>{await other.$disconnect();await prisma.$disconnect();});

async function authority(){
 const admin=await createTestCustomer({role:"SUPER_ADMIN"});
 const displayed:Record<string,LegalDocumentType>={CUSTOMER_RENTAL:"RENTAL_AGREEMENT",HOST_VEHICLE:"HOST_AGREEMENT",PRIVACY:"PRIVACY_POLICY",TERMS:"TERMS_AND_CONDITIONS",CANCELLATION:"CANCELLATION_POLICY",DEPOSIT:"SECURITY_DEPOSIT_POLICY",DAMAGE:"DAMAGE_POLICY",INSURANCE:"INSURANCE_POLICY"};
 const ids:Record<string,string>={};
 for(const kind of POLICY_KINDS){
  const content="CONTROLLED TEST EVIDENCE ONLY "+kind;
  if(displayed[kind])await prisma.legalDocument.upsert({where:{type:displayed[kind]},create:{type:displayed[kind],title:kind,content,version:"fixture",needsAttorneyReview:false},update:{content,needsAttorneyReview:false}});
  const row=await prisma.policyApproval.create({data:{kind,version:randomUUID(),jurisdiction:"US-TX",contentHash:createHash("sha256").update(content).digest("hex"),professionalReviewRequired:true,professionalReference:"Controlled fixture, not legal approval",approvedById:admin.id,approvedAt:new Date(),effectiveAt:new Date(),status:"APPROVED"}});ids[kind]=row.id;
 }
 for(const key of ["hosting","booking","deposits"])await prisma.releaseFeature.upsert({where:{key},create:{key,enabled:true},update:{enabled:true}});
 vi.stubEnv("APP_ENV","staging");return ids;
}
async function assertBlocked(pid:()=>number){
 let blocked=false;for(let i=0;i<300;i++){const rows=await prisma.$queryRaw<Array<{waiting:boolean}>>`SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=${pid()}`;if(rows[0]?.waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);
}
it.each(["disable","revoke"] as const)("%s authority wins against a concurrent activation with zero bookability changes",async action=>{
 const host=await createTestHost(),v=await createTestVehicle({hostId:host.hostProfile.id,listingApproval:"APPROVED"}),ids=await authority();
 // A historical agreement is insufficient once current authority closes.
 await prisma.$transaction(tx=>recordAgreementAcceptance(tx,{type:"HOST_AGREEMENT",vehicleId:v.id,signedByUserId:host.user.id,signerName:"Synthetic Host",ipAddress:null,userAgent:null}));
 const entered=barrier(),release=barrier();let writerPid=0;
 const closing=other.$transaction(async tx=>{writerPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;if(action==="disable")await tx.releaseFeature.update({where:{key:"hosting"},data:{enabled:false}});else await tx.policyApproval.update({where:{id:ids.HOST_VEHICLE},data:{status:"REVOKED"}});entered.release();await release.wait;},{timeout:15000});
 await entered.wait;const activation=Promise.allSettled([hostCommand(host.user.id,{action:"availability",vehicleId:v.id,isBookable:true})]);
 try{let blocked=false;for(let i=0;i<300;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>${writerPid} AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock_shared%'`;if(rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);}finally{release.release();await closing;}
 expect((await activation)[0].status).toBe("rejected");expect(await prisma.vehicleAvailabilityConfig.count({where:{vehicleId:v.id,isBookable:true}})).toBe(0);
});
it("policy revocation serializes against signing on a different PostgreSQL connection",async()=>{
 const customer=await createTestCustomer(),v=await createTestVehicle(),ids=await authority(),entered=barrier(),release=barrier();let readerPid=0;
 const closing=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;await tx.policyApproval.update({where:{id:ids.HOST_VEHICLE},data:{status:"REVOKED"}});entered.release();await release.wait;},{timeout:15000});
 await entered.wait;
 const signing=Promise.allSettled([other.$transaction(async tx=>{readerPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;return recordAgreementAcceptance(tx,{type:"HOST_AGREEMENT",vehicleId:v.id,signedByUserId:customer.id,signerName:"Synthetic Signer",ipAddress:null,userAgent:null});},{timeout:15000})]);
 try{await assertBlocked(()=>readerPid);}finally{release.release();await closing;}
 const result=(await signing)[0];expect(result.status).toBe("rejected");if(result.status==="rejected")expect(String(result.reason)).toContain("FEATURE_NOT_RELEASED");
 expect(await prisma.agreementAcceptance.count({where:{vehicleId:v.id}})).toBe(0);
});

it.each([[0,"disable"],[30000,"disable"],[0,"revoke"],[30000,"revoke"]] as const)("final confirmation fences %i deposit after concurrent %s and compensates once",async(depositCents,action)=>{
 const customer=await createTestCustomer(),v=await createTestVehicle(),r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date("2049-01-01"),returnAt:new Date("2049-01-04"),status:"AWAITING_PAYMENT",depositCents,expiresAt:new Date(Date.now()+600000)});
 const payment=await prisma.payment.create({data:{reservationId:r.id,amountCents:r.totalCents,type:"RENTAL",status:"SUCCEEDED",stripePaymentIntentId:"pi_"+randomUUID()}});
 const deposit=depositCents?await prisma.securityDeposit.create({data:{reservationId:r.id,amountCents:depositCents}}):null;
 const ids=await authority(),entered=barrier(),release=barrier(),writerReady=barrier(),writerRelease=barrier();let writerPid=0;
 const intent={id:payment.stripePaymentIntentId!,amount:r.totalCents,currency:"usd",status:"succeeded",customer:"cus_fixture",payment_method:"pm_fixture"} as Stripe.PaymentIntent;
 let authorized:Stripe.PaymentIntent;
 provider.create.mockImplementation(async(params:Stripe.PaymentIntentCreateParams)=>{authorized={...params,id:"pi_deposit_"+randomUUID(),status:"requires_capture",amount:depositCents,amount_capturable:depositCents,created:Math.floor(Date.now()/1000),currency:"usd",latest_charge:{id:"ch_fixture",created:Math.floor(Date.now()/1000),payment_method_details:{card:{capture_before:Math.floor(Date.now()/1000)+86400}}}} as Stripe.PaymentIntent;return authorized;});
 provider.retrieve.mockImplementation(async()=>authorized);
 provider.cancel.mockImplementation(async()=>{authorized={...authorized,status:"canceled",amount_capturable:0};return authorized;});
 provider.refund.mockImplementation(async(params:Stripe.RefundCreateParams)=>({id:"re_"+randomUUID(),status:"succeeded",amount:params.amount,currency:"usd",payment_intent:params.payment_intent,metadata:params.metadata}));
 const original=deposits.attemptDepositAuthorization;
 vi.spyOn(deposits,"attemptDepositAuthorization").mockImplementation(async(...args)=>{const result=await original(...args);entered.release();await release.wait;return result;});
 const confirmation=confirmAfterRentalPaymentSuccess({...r,deposit},payment,intent);const outcome=Promise.allSettled([confirmation]);await entered.wait;
 const closing=other.$transaction(async tx=>{writerPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;if(action==="disable")await tx.releaseFeature.update({where:{key:"booking"},data:{enabled:false}});else await tx.policyApproval.update({where:{id:ids.CUSTOMER_RENTAL},data:{status:"REVOKED"}});writerReady.release();await writerRelease.wait;},{timeout:15000});
 await writerReady.wait;release.release();
 try{let blocked=false;for(let i=0;i<300;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>${writerPid} AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock_shared%'`;if(rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);}finally{writerRelease.release();await closing;}
 const result=(await outcome)[0];expect(result.status,result.status==="rejected"?String(result.reason):"").toBe("fulfilled");if(result.status==="fulfilled")expect(result.value.confirmed).toBe(false);
 await confirmAfterRentalPaymentSuccess({...r,deposit},payment,intent);await settleTerminatedReservation(r.id);
 expect(await prisma.payment.findUniqueOrThrow({where:{id:payment.id}})).toMatchObject({status:"SUCCEEDED"});
 expect(await prisma.reservation.findUniqueOrThrow({where:{id:r.id}})).toMatchObject({financialDisposition:"TERMINATED"});
 expect(await prisma.refund.count({where:{reservationId:r.id,status:"SUCCEEDED"}})).toBe(1);
 expect(await prisma.financialOperation.count({where:{reservationId:r.id,kind:"REFUND"}})).toBe(1);
 expect(await prisma.tripEvent.count({where:{reservationId:r.id,type:"PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED"}})).toBe(0);
 expect(provider.refund).toHaveBeenCalledTimes(1);expect(provider.create).toHaveBeenCalledTimes(depositCents?1:0);expect(provider.cancel).toHaveBeenCalledTimes(depositCents?1:0);
 console.info(JSON.stringify({race:"final-confirmation",depositCents,action,refundCreates:provider.refund.mock.calls.length,depositCreates:provider.create.mock.calls.length,depositCancels:provider.cancel.mock.calls.length}));
});
