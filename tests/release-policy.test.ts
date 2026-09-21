import {afterAll,afterEach,it,expect,vi} from "vitest";
import {createHash,randomUUID} from "node:crypto";
import {requireReleaseFeature} from "@/lib/release-control";
import {productionConfiguration} from "@/lib/production-config";
import {prisma,createTestCustomer} from "./helpers/factories";
import {configured} from "./helpers/production-config-fixture";
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>prisma.$disconnect());
it("requires effective professional approvals and exact displayed content, and never falls back after revocation",async()=>{
 // Connect to the real disposable database before replacing configuration syntax inputs.
 await prisma.$connect();const reviewer=await createTestCustomer({role:"SUPER_ADMIN"});
 const original=await prisma.legalDocument.findUnique({where:{type:"PRIVACY_POLICY"}}),flag=await prisma.releaseFeature.findUnique({where:{key:"sms"}});
 const content="SYNTHETIC POLICY FIXTURE - NOT LEGAL LANGUAGE "+randomUUID(),hash=createHash("sha256").update(content).digest("hex");
 try{
  await prisma.legalDocument.upsert({where:{type:"PRIVACY_POLICY"},create:{type:"PRIVACY_POLICY",title:"Synthetic privacy fixture",content,needsAttorneyReview:false},update:{content,needsAttorneyReview:false}});
  await prisma.releaseFeature.upsert({where:{key:"sms"},create:{key:"sms",enabled:true},update:{enabled:true}});
  for(const [key,value]of Object.entries({...configured(),NEXTAUTH_URL:"https://staging.renta4wheel.com",AUTH_URL:"https://staging.renta4wheel.com",NEXT_PUBLIC_SITE_URL:"https://staging.renta4wheel.com",ALLOW_DEV_PAYMENT_SIMULATION:"false",ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV:"false",LOCAL_BUILD_WORKER_THREADS:"false",LIVE_FINANCE_ENABLED:"false",VERCEL_ENV:""}))vi.stubEnv(key,value);
  expect(productionConfiguration().issues).toEqual([]);
  for(const kind of ["SMS_CONSENT","PRIVACY"])await prisma.policyApproval.create({data:{kind,jurisdiction:"GLOBAL",version:randomUUID(),contentHash:kind==="PRIVACY"?hash:"b".repeat(64),status:"APPROVED",professionalReference:"CONTROLLED TEST FIXTURE - NO REAL APPROVAL",approvedById:reviewer.id,approvedAt:new Date(),effectiveAt:new Date()}});
  await expect(requireReleaseFeature("sms",prisma)).resolves.toBeUndefined();
  await prisma.legalDocument.update({where:{type:"PRIVACY_POLICY"},data:{content:content+" changed"}});await expect(requireReleaseFeature("sms",prisma)).rejects.toThrow("FEATURE_NOT_RELEASED");
  await prisma.legalDocument.update({where:{type:"PRIVACY_POLICY"},data:{content}});
  await prisma.policyApproval.create({data:{kind:"SMS_CONSENT",jurisdiction:"GLOBAL",version:randomUUID(),contentHash:"b".repeat(64),status:"REVOKED",effectiveAt:new Date()}});
  await expect(requireReleaseFeature("sms",prisma)).rejects.toThrow("FEATURE_NOT_RELEASED");
  await expect(requireReleaseFeature("live_charges",prisma)).rejects.toThrow("FEATURE_NOT_RELEASED");
 }finally{
  vi.unstubAllEnvs();if(original)await prisma.legalDocument.update({where:{type:"PRIVACY_POLICY"},data:{content:original.content,needsAttorneyReview:original.needsAttorneyReview}});
  if(!original)await prisma.legalDocument.delete({where:{type:"PRIVACY_POLICY"}});await prisma.releaseFeature.update({where:{key:"sms"},data:{enabled:flag?.enabled??false}});
 }
 // Immutable synthetic approval evidence remains only in this disposable database.
});
