import {afterAll,afterEach,it,expect,vi} from "vitest";
import {prisma,createTestCustomer,createTestHost,createTestVehicle,createTestReservation} from "./helpers/factories";
import {fixtureJurisdiction} from "./helpers/jurisdiction-fixture";
import {hostCommand} from "@/lib/marketplace";
import {openConversation,messageCommand} from "@/lib/conversations";
import {confirmAfterRentalPaymentSuccess} from "@/lib/stripe-webhook-handlers";
import type Stripe from "stripe";
const session=vi.hoisted(()=>({id:"",role:"CUSTOMER"}));
vi.mock("@/auth",()=>({auth:async()=>({user:session})}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/production-config",()=>({productionConfiguration:()=>({ready:true,issues:[]})}));
// Real operation reservation/projection is retained; a disabled admission still
// creates a durable refund even when its provider is temporarily unavailable.
vi.mock("@/lib/stripe",()=>({stripe:null}));
import {POST as community} from "@/app/api/community/route";
import {POST as approval} from "@/app/api/admin/marketplace/route";
import {setVehicleStatus} from "@/app/admin/vehicles/actions";
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>prisma.$disconnect());

it.each(["disabled","expired","revoked","missing"] as const)("rejects direct prebooking inquiry API with %s authority and zero business side effects",async(kind)=>{
 const host=await createTestHost(),customer=await createTestCustomer(),v=await createTestVehicle({hostId:host.hostProfile.id,listingApproval:"APPROVED",jurisdictionCode:"OR"});
 await fixtureJurisdiction(prisma,"OR");
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date("2046-01-01"),returnAt:new Date("2046-01-04"),status:"ACTIVE"});
 const historical=await openConversation(customer.id,{reservationId:r.id});
 if(kind==="disabled")await prisma.jurisdiction.update({where:{code:"OR"},data:{mode:"DISABLED"}});
 else if(kind==="missing"){ await prisma.jurisdiction.update({where:{code:"VT"},data:{mode:"STAGING"}}); expect(await prisma.jurisdictionApproval.count({where:{jurisdictionCode:"VT"}})).toBe(0); await prisma.vehicle.update({where:{id:v.id},data:{jurisdictionCode:"VT"}}); }
 else{
  const last=await prisma.jurisdictionApproval.findFirstOrThrow({where:{jurisdictionCode:"OR",category:"INSURANCE"},orderBy:{version:"desc"}});
  if(kind==="revoked")await prisma.jurisdictionApproval.update({where:{id:last.id},data:{status:"REVOKED"}});
  else await prisma.jurisdictionApproval.create({data:{jurisdictionCode:"OR",category:"INSURANCE",version:last.version+1,status:"STAGING_READY",contentHash:last.contentHash,reviewedById:last.reviewedById,reviewedAt:new Date(),effectiveAt:new Date(0),endsAt:new Date(1),evidenceReference:"CONTROLLED_EXPIRED_FIXTURE"}});
 }
 session.id=customer.id;session.role="CUSTOMER";
 const before=await Promise.all([prisma.conversation.count(),prisma.inboxNotice.count(),prisma.outboxMessage.count(),prisma.auditLog.count()]);
 const origin=new URL(process.env.AUTH_URL??process.env.NEXTAUTH_URL??"http://localhost:3000").origin;
 const response=await community(new Request(origin+"/api/community",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({action:"conversation",vehicleId:v.id})}));
 expect(response.status).toBe(409);
 expect(await Promise.all([prisma.conversation.count(),prisma.inboxNotice.count(),prisma.outboxMessage.count(),prisma.auditLog.count()])).toEqual(before);
 await expect(messageCommand(customer.id,historical.id,{action:"send",body:"Please coordinate the existing return."})).resolves.toBeDefined();
 expect(await openConversation(customer.id,{reservationId:r.id})).toEqual(historical);
 await fixtureJurisdiction(prisma,"OR");
});

it("blocks host approval after hosting closes, even with a valid jurisdiction",async()=>{
 const host=await createTestHost(),admin=await createTestCustomer({role:"SUPER_ADMIN"});
 await prisma.hostProfile.update({where:{id:host.hostProfile.id},data:{onboardingStatus:"SUBMITTED"}});
 await prisma.releaseFeature.upsert({where:{key:"hosting"},create:{key:"hosting",enabled:false},update:{enabled:false}});
 vi.stubEnv("APP_ENV","staging");session.id=admin.id;session.role="SUPER_ADMIN";
 const response=await approval(new Request("https://fixture.invalid/api/admin/marketplace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"host",id:host.hostProfile.id,status:"APPROVED",reason:"Review synthetic evidence"})}));
 expect(response.status).toBe(409);
 expect((await prisma.hostProfile.findUniqueOrThrow({where:{id:host.hostProfile.id}})).onboardingStatus).toBe("SUBMITTED");
});

it("prevents making an already approved listing bookable after hosting closes",async()=>{
 const host=await createTestHost(),v=await createTestVehicle({hostId:host.hostProfile.id,listingApproval:"APPROVED"});
 await prisma.releaseFeature.upsert({where:{key:"hosting"},create:{key:"hosting",enabled:false},update:{enabled:false}});
 vi.stubEnv("APP_ENV","staging");
 await expect(hostCommand(host.user.id,{action:"availability",vehicleId:v.id,isBookable:true})).rejects.toThrow("FEATURE_NOT_RELEASED");
 expect(await prisma.vehicleAvailabilityConfig.count({where:{vehicleId:v.id,isBookable:true}})).toBe(0);
});

it("legacy vehicle status action cannot bypass hosting admission",async()=>{
 const admin=await createTestCustomer({role:"SUPER_ADMIN"}),v=await createTestVehicle({status:"INACTIVE",listingApproval:"APPROVED"});
 await prisma.releaseFeature.upsert({where:{key:"hosting"},create:{key:"hosting",enabled:false},update:{enabled:false}});
 session.id=admin.id;session.role="SUPER_ADMIN";vi.stubEnv("APP_ENV","staging");
 await expect(setVehicleStatus(v.id,"ACTIVE")).rejects.toThrow("FEATURE_NOT_RELEASED");
 expect((await prisma.vehicle.findUniqueOrThrow({where:{id:v.id}})).status).toBe("INACTIVE");
});

it.each([0,30000])("retains successful payment and one durable refund when booking closes before confirmation (deposit %i)",async(depositCents)=>{
 const host=await createTestHost(),customer=await createTestCustomer(),v=await createTestVehicle({hostId:host.hostProfile.id,listingApproval:"APPROVED"});
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date("2047-01-01"),returnAt:new Date("2047-01-04"),status:"AWAITING_PAYMENT",expiresAt:new Date(Date.now()+600000),depositCents});
 const p=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:r.totalCents,stripePaymentIntentId:"pi_"+crypto.randomUUID()}});
 await prisma.releaseFeature.upsert({where:{key:"booking"},create:{key:"booking",enabled:false},update:{enabled:false}});vi.stubEnv("APP_ENV","staging");
 const intent={id:p.stripePaymentIntentId!,amount:p.amountCents,currency:"usd",status:"succeeded"} as Stripe.PaymentIntent;
 for(let i=0;i<2;i++)await expect(confirmAfterRentalPaymentSuccess({...r,deposit:null},p,intent)).rejects.toThrow("Stripe refund provider unavailable");
 expect((await prisma.reservation.findUniqueOrThrow({where:{id:r.id}})).financialDisposition).toBe("REFUND_REQUIRED");
 expect((await prisma.payment.findUniqueOrThrow({where:{id:p.id}})).status).toBe("SUCCEEDED");
 expect(await prisma.refund.count({where:{paymentId:p.id}})).toBe(1);
 expect(await prisma.tripEvent.count({where:{reservationId:r.id,type:"PAYMENT_SUCCEEDED_RESERVATION_CONFIRMED"}})).toBe(0);
});
