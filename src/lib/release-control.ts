import type { Prisma,LegalDocumentType } from "@prisma/client";
import {createHash} from "node:crypto";
import { prisma } from "@/lib/prisma";
import { localDevelopment, deploymentEnvironment } from "@/lib/deployment-environment";
import { productionConfiguration } from "@/lib/production-config";
import { verifyAuthCode } from "@/lib/auth-code";
export const FEATURES = ["booking","hosting","live_charges","deposits","connect","transfers","payouts","sms","reviews","claims"] as const;
export type ReleaseFeatureKey = typeof FEATURES[number];
export const POLICY_KINDS = ["CUSTOMER_RENTAL","HOST_VEHICLE","PRIVACY","TERMS","CANCELLATION","DEPOSIT","DAMAGE","CLAIMS","INSURANCE","MILEAGE_FUEL_LATE","RETENTION","SMS_CONSENT","PAYOUT_COMMISSION","TAX_PROCEDURES"] as const;
const policies:Record<ReleaseFeatureKey,readonly string[]>={booking:["CUSTOMER_RENTAL","PRIVACY","TERMS","CANCELLATION","DEPOSIT","DAMAGE","CLAIMS","INSURANCE","MILEAGE_FUEL_LATE","RETENTION"],hosting:["HOST_VEHICLE","PRIVACY","TERMS","INSURANCE","RETENTION"],live_charges:["CUSTOMER_RENTAL","TAX_PROCEDURES"],deposits:["DEPOSIT","DAMAGE","RETENTION"],connect:["HOST_VEHICLE","PAYOUT_COMMISSION","TAX_PROCEDURES"],transfers:["PAYOUT_COMMISSION","TAX_PROCEDURES"],payouts:["PAYOUT_COMMISSION","TAX_PROCEDURES"],sms:["SMS_CONSENT","PRIVACY"],reviews:["TERMS","PRIVACY"],claims:["CLAIMS","DAMAGE","INSURANCE","RETENTION"]};
export class ReleaseGateError extends Error {constructor(){super("FEATURE_NOT_RELEASED");}}
export async function requireReleaseFeature(key:ReleaseFeatureKey,tx:Prisma.TransactionClient=prisma,jurisdictionCode?:string){
 if(key==="live_charges")throw new ReleaseGateError();
 if(localDevelopment())return;
 if(!productionConfiguration().ready)throw new ReleaseGateError();
 if(deploymentEnvironment()==="preview"&&["deposits","connect","transfers","payouts","sms"].includes(key))throw new ReleaseGateError();
 if(!(await tx.releaseFeature.findUnique({where:{key}}))?.enabled)throw new ReleaseGateError();
 const versions=await tx.policyApproval.findMany({where:{kind:{in:[...policies[key]]},jurisdiction:jurisdictionCode?"US-"+jurisdictionCode:"GLOBAL",effectiveAt:{lte:new Date()}},orderBy:[{effectiveAt:"desc"},{createdAt:"desc"}],select:{kind:true,status:true,approvedAt:true,approvedById:true,contentHash:true,professionalReviewRequired:true,professionalReference:true}});
 const approved=policies[key].map(kind=>versions.find(v=>v.kind===kind)).filter(v=>v?.status==="APPROVED"&&v.approvedAt&&v.approvedById).map(v=>v!);
 if(policies[key].some(kind=>!approved.some(a=>a.kind===kind&&(!a.professionalReviewRequired||Boolean(a.professionalReference)))))throw new ReleaseGateError();
 const displayed:Record<string,LegalDocumentType>={CUSTOMER_RENTAL:"RENTAL_AGREEMENT",HOST_VEHICLE:"HOST_AGREEMENT",PRIVACY:"PRIVACY_POLICY",TERMS:"TERMS_AND_CONDITIONS",CANCELLATION:"CANCELLATION_POLICY",DEPOSIT:"SECURITY_DEPOSIT_POLICY",DAMAGE:"DAMAGE_POLICY",INSURANCE:"INSURANCE_POLICY"};
 for(const kind of policies[key])if(displayed[kind]){const doc=await tx.legalDocument.findUnique({where:{type:displayed[kind]}});if(!doc||doc.needsAttorneyReview||!approved.some(a=>a.kind===kind&&a.contentHash===createHash("sha256").update(doc.content).digest("hex")))throw new ReleaseGateError();}
}
export async function securityStepUp(userId:string,code:string){
 const user=await prisma.user.findUnique({where:{id:userId}});
 if(!user?.isActive||user.role!=="SUPER_ADMIN"||!/^\d{6}$/.test(code)||!(await verifyAuthCode({email:user.email,code,ip:null,purpose:"SECURITY_STEP_UP"})).ok)throw new Error("SECURITY_REAUTHENTICATION_REQUIRED");
}
export async function setReleaseFeature(userId:string,key:ReleaseFeatureKey,enabled:boolean,code:string,reason:string){
 if(!FEATURES.includes(key)||reason.trim().length<10||reason.length>500||key==="live_charges"&&enabled)throw new ReleaseGateError();
 await securityStepUp(userId,code);
 return prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;
  const actor=await tx.user.findUnique({where:{id:userId}});if(!actor?.isActive||actor.role!=="SUPER_ADMIN")throw new ReleaseGateError();
  const result=await tx.releaseFeature.upsert({where:{key},create:{key,enabled},update:{enabled,version:{increment:1}}});
  if(enabled&&!localDevelopment()&&!productionConfiguration().ready)throw new ReleaseGateError();
  await tx.auditLog.create({data:{actorId:userId,action:"security.feature.changed",entityType:"ReleaseFeature",entityId:key,metadata:{enabled,reason,version:result.version}}});
  return {key,enabled,version:result.version};
 });
}
export async function registerPolicy(userId:string,input:{kind:string;version:string;contentHash:string;professionalReference:string;effectiveAt:string;code:string;supersedesId?:string;jurisdiction:string}){
 if(!/^(GLOBAL|US-[A-Z]{2})$/.test(input.jurisdiction)||!(POLICY_KINDS as readonly string[]).includes(input.kind)||!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(input.version)||!/^[a-f0-9]{64}$/.test(input.contentHash)||input.professionalReference.length<10||input.professionalReference.length>500||!Number.isFinite(Date.parse(input.effectiveAt)))throw new Error("INVALID_POLICY_APPROVAL");
 await securityStepUp(userId,input.code);
 return prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;
  const actor=await tx.user.findUnique({where:{id:userId}});if(!actor?.isActive||actor.role!=="SUPER_ADMIN")throw new ReleaseGateError();
  if(input.supersedesId){const old=await tx.policyApproval.findUniqueOrThrow({where:{id:input.supersedesId}});if(old.kind!==input.kind||old.jurisdiction!==input.jurisdiction)throw new Error("INVALID_POLICY_APPROVAL");}
  const row=await tx.policyApproval.create({data:{kind:input.kind,version:input.version,contentHash:input.contentHash,jurisdiction:input.jurisdiction,professionalReviewRequired:true,professionalReference:input.professionalReference,approvedById:userId,approvedAt:new Date(),effectiveAt:new Date(input.effectiveAt),status:"APPROVED",supersedesId:input.supersedesId}});
  await tx.auditLog.create({data:{actorId:userId,action:"security.policy.approved",entityType:"PolicyApproval",entityId:row.id,metadata:{kind:row.kind,version:row.version,contentHash:row.contentHash}}});return {id:row.id};
 });
}
