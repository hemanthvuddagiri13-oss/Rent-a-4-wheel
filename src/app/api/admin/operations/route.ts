import { auth } from "@/auth";
import {importLegacyPrivateObject} from "@/lib/legacy-private-import";
import { jurisdictionAdminCommand } from "@/lib/jurisdiction-admin";
import { prisma } from "@/lib/prisma";
import { productionConfiguration } from "@/lib/production-config";
import { operationalMetrics } from "@/lib/operations";
import { FEATURES,registerPolicy,setReleaseFeature } from "@/lib/release-control";
import {adminExecution,assertAdminExecution,protectedAdminMutation} from "@/lib/protected-admin";
import { requestAuthCode } from "@/lib/auth-code";
import { boundedBody } from "@/lib/bounded-request";
import { requestOriginAllowed } from "@/lib/security-request";
export async function GET(){const session=await auth();if(session?.user?.role!=="SUPER_ADMIN")return Response.json({error:"Forbidden"},{status:403});return Response.json({configuration:productionConfiguration(),metrics:await operationalMetrics(),flags:await prisma.releaseFeature.findMany({select:{key:true,enabled:true,version:true}}),policies:await prisma.policyApproval.findMany({select:{id:true,kind:true,version:true,status:true,contentHash:true,effectiveAt:true}}),jobs:await prisma.operationsJob.findMany({where:{state:"REVIEW"},select:{key:true,kind:true,state:true,attempts:true,lastErrorCode:true},take:50,orderBy:{updatedAt:"asc"}})},{headers:{"Cache-Control":"no-store"}});}
export async function POST(req:Request){
 const session=await auth();if(session?.user?.role!=="SUPER_ADMIN")return Response.json({error:"Forbidden"},{status:403});if(!requestOriginAllowed(req))return Response.json({error:"Invalid origin"},{status:403});
 try{const data=JSON.parse((await boundedBody(req,8000)).toString("utf8")),userId=session.user.id,execution=adminExecution(session,req.headers);
  if(data.action==="stepUp"){const user=await prisma.$transaction(tx=>assertAdminExecution(tx,userId,execution));const result=await requestAuthCode({email:user.email,ip:null,purpose:"SECURITY_STEP_UP"});return Response.json({success:result.ok},{status:result.ok?200:429});}
  if(data.action==="feature"&&FEATURES.includes(data.key)&&typeof data.enabled==="boolean")return Response.json(await setReleaseFeature(userId,data.key,data.enabled,String(data.code??""),String(data.reason??""),data.confirm,execution));
  if(data.action==="policy")return Response.json(await registerPolicy(userId,data,execution));
  if(data.action==="importLegacyObject")return Response.json(await importLegacyPrivateObject(userId,data,execution));
  if(["jurisdictionMode","jurisdictionGate","pricingPolicy","revokeJurisdictionGate","revokePricingPolicy"].includes(data.action))return Response.json(await jurisdictionAdminCommand(userId,data,execution));
  if(data.action==="retry"&&typeof data.key==="string"&&data.key.length<=200){const result=await protectedAdminMutation(userId,data,execution,"retry",async tx=>{const changed=await tx.$executeRaw`UPDATE "OperationsJob" SET state='RETRY',attempts=0,"nextAttemptAt"=(clock_timestamp() AT TIME ZONE 'UTC'),"leaseToken"=NULL,"leaseExpiresAt"=NULL WHERE key=${data.key} AND state='REVIEW' AND kind IN ('SCAN','DELETE','AGREEMENT','ALERT')`;await tx.auditLog.create({data:{actorId:userId,action:"operations.review.retry",entityType:"OperationsJob",entityId:data.key,metadata:{reason:data.reason,count:changed}}});return {retried:changed};});return Response.json(result);}
  return Response.json({error:"Invalid operation"},{status:400});
 }catch{return Response.json({error:"Operation refused. Check prerequisites and use a fresh security code."},{status:409});}
}
