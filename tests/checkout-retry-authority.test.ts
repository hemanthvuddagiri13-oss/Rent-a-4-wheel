import {it,expect,vi,afterAll,afterEach} from "vitest";
import {NextRequest} from "next/server";
import {createHash,randomUUID} from "node:crypto";
import {type LegalDocumentType} from "@prisma/client";
import {prisma,createTestCustomer,createTestVehicle,createTestReservation,cleanupReservationsForVehicles} from "./helpers/factories";
import {fingerprint} from "@/lib/financial-operations";
import {checkoutSchema} from "@/lib/validations/reservation";
import {POLICY_KINDS} from "@/lib/release-control";
import {barrier} from "./helpers/barrier";
import * as availability from "@/lib/availability";
const session=vi.hoisted(()=>({id:""}));
vi.mock("@/auth",()=>({auth:async()=>({user:session})}));
vi.mock("@/lib/production-config",()=>({productionConfiguration:()=>({ready:true,issues:[]})}));
import {POST} from "@/app/api/reservations/[id]/checkout/route";
const vehicles:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await cleanupReservationsForVehicles(vehicles.splice(0));});afterAll(()=>prisma.$disconnect());
async function authority(){
 const admin=await createTestCustomer({role:"SUPER_ADMIN"});let rental="";
 const displayed:Record<string,LegalDocumentType>={CUSTOMER_RENTAL:"RENTAL_AGREEMENT",HOST_VEHICLE:"HOST_AGREEMENT",PRIVACY:"PRIVACY_POLICY",TERMS:"TERMS_AND_CONDITIONS",CANCELLATION:"CANCELLATION_POLICY",DEPOSIT:"SECURITY_DEPOSIT_POLICY",DAMAGE:"DAMAGE_POLICY",INSURANCE:"INSURANCE_POLICY"};
 for(const kind of POLICY_KINDS){const content="CONTROLLED RETRY FIXTURE "+kind;
  if(displayed[kind])await prisma.legalDocument.upsert({where:{type:displayed[kind]},create:{type:displayed[kind],title:kind,content,version:"retry",needsAttorneyReview:false},update:{content,needsAttorneyReview:false}});
  const row=await prisma.policyApproval.create({data:{kind,version:randomUUID(),jurisdiction:"US-TX",contentHash:createHash("sha256").update(content).digest("hex"),professionalReviewRequired:true,professionalReference:"Controlled fixture only",approvedById:admin.id,approvedAt:new Date(),effectiveAt:new Date(),status:"APPROVED"}});if(kind==="CUSTOMER_RENTAL")rental=row.id;
 }
 await prisma.releaseFeature.upsert({where:{key:"booking"},create:{key:"booking",enabled:true},update:{enabled:true}});vi.stubEnv("APP_ENV","staging");return rental;
}
for(const path of ["early","concurrent"] as const)for(const operation of [false,true])it.each(["disable","revoke","valid"] as const)(`${path} retry (operation ${operation}) rechecks %s authority without financial mutation`,async action=>{
 const u=await createTestCustomer(),v=await createTestVehicle();vehicles.push(v.id);session.id=u.id;
 const r=await createTestReservation({vehicleId:v.id,customerId:u.id,status:path==="early"?"AWAITING_PAYMENT":"CHECKOUT_HOLD",pickupAt:new Date("2052-01-01"),returnAt:new Date("2052-01-04"),expiresAt:new Date(Date.now()+600000)});
 const docs=[];for(const type of ["LICENSE_FRONT","LICENSE_BACK","SELFIE_WITH_LICENSE"] as const)docs.push(await prisma.driverDocument.create({data:{userId:u.id,reservationId:r.id,type,storageKey:"fixture:"+randomUUID(),mimeType:"image/png",fileSizeBytes:1,contentSha256:"fixture",malwareScanStatus:"CLEAN"}}));
 const body={agreementAccepted:true,documentIds:{front:docs[0].id,back:docs[1].id,selfie:docs[2].id},driver:{firstName:"Test",lastName:"Driver",dob:"1990-01-01",email:u.email,phone:"5551234567",address:"1 Fixture St",city:"Dallas",state:"TX",zip:"75001",country:"US",licenseNumber:"TEST",licenseState:"TX",licenseExpiration:"2053-01-01"}};
 const hash=fingerprint(checkoutSchema.parse(body)),policy=await authority();
 if(operation)await prisma.financialOperation.create({data:{key:"retry:"+r.id,kind:"RENTAL",reservationId:r.id,fingerprint:hash,payload:{fixture:true},providerId:"pi_retry_"+r.id,state:"OBSERVED"}});
 const close=async()=>{if(action==="disable")await prisma.releaseFeature.update({where:{key:"booking"},data:{enabled:false}});if(action==="revoke")await prisma.policyApproval.update({where:{id:policy},data:{status:"REVOKED"}});};
 const entered=barrier(),release=barrier();
 if(path==="early"){await prisma.reservation.update({where:{id:r.id},data:{checkoutFingerprint:hash}});await close();}
 else {const real=availability.isVehicleAvailable;vi.spyOn(availability,"isVehicleAvailable").mockImplementationOnce(async(...args)=>{const result=await real(...args);entered.release();await release.wait;return result;});}
 const execute=()=>POST(new NextRequest("http://localhost:3000/api/reservations/"+r.id+"/checkout",{method:"POST",body:JSON.stringify(body),headers:{"content-type":"application/json"}}),{params:Promise.resolve({id:r.id})});
 let running:ReturnType<typeof execute>|undefined;
 if(path==="concurrent"){running=execute();await entered.wait;await prisma.reservation.update({where:{id:r.id},data:{checkoutFingerprint:hash,status:"AWAITING_PAYMENT"}});await close();}
 const snapshot=async()=>({r:await prisma.reservation.findUnique({where:{id:r.id}}),payments:await prisma.payment.findMany({where:{reservationId:r.id}}),operations:await prisma.financialOperation.findMany({where:{reservationId:r.id},include:{dispatches:true}}),events:await prisma.tripEvent.findMany({where:{reservationId:r.id}})});
 const before=await snapshot();release.release();const response=await(running??execute()),result=await response.json();
 expect(response.status).toBe(action==="valid"?200:409);
 if(action==="valid")expect(result.success).toBe(true);else expect(result).toMatchObject({success:false,status:"HISTORICAL_CHECKOUT_NOT_ELIGIBLE",paymentEligible:false,historicalCheckout:true});
 expect(await snapshot()).toEqual(before);
});
