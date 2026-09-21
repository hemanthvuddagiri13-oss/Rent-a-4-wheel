import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { productionConfiguration } from "@/lib/production-config";
import { operationalMetrics } from "@/lib/operations";
import { FEATURES,registerPolicy,securityStepUp,setReleaseFeature } from "@/lib/release-control";
import { requestAuthCode } from "@/lib/auth-code";
import { boundedBody } from "@/lib/bounded-request";
import { requestOriginAllowed } from "@/lib/security-request";
export async function GET(){const session=await auth();if(session?.user?.role!=="SUPER_ADMIN")return Response.json({error:"Forbidden"},{status:403});return Response.json({configuration:productionConfiguration(),metrics:await operationalMetrics(),flags:await prisma.releaseFeature.findMany({select:{key:true,enabled:true,version:true}}),policies:await prisma.policyApproval.findMany({select:{id:true,kind:true,version:true,status:true,contentHash:true,effectiveAt:true}}),jobs:await prisma.operationsJob.findMany({where:{state:"REVIEW"},select:{key:true,kind:true,state:true,attempts:true,lastErrorCode:true},take:50,orderBy:{updatedAt:"asc"}})},{headers:{"Cache-Control":"no-store"}});}
export async function POST(req:Request){
 const session=await auth();if(session?.user?.role!=="SUPER_ADMIN")return Response.json({error:"Forbidden"},{status:403});if(!requestOriginAllowed(req))return Response.json({error:"Invalid origin"},{status:403});
 try{const data=JSON.parse((await boundedBody(req,8000)).toString("utf8")),userId=session.user.id;
  if(data.action==="stepUp"){const user=await prisma.user.findUniqueOrThrow({where:{id:userId}});const result=await requestAuthCode({email:user.email,ip:null,purpose:"SECURITY_STEP_UP"});return Response.json({success:result.ok},{status:result.ok?200:429});}
  if(data.action==="feature"&&FEATURES.includes(data.key)&&typeof data.enabled==="boolean")return Response.json(await setReleaseFeature(userId,data.key,data.enabled,String(data.code??""),String(data.reason??"")));
  if(data.action==="policy")return Response.json(await registerPolicy(userId,data));
  if(data.action==="retry"&&typeof data.key==="string"&&data.key.length<=200&&typeof data.reason==="string"&&data.reason.length>=10&&data.reason.length<=500){await securityStepUp(userId,String(data.code??""));const result=await prisma.$transaction(async tx=>{const actor=await tx.user.findUniqueOrThrow({where:{id:userId}});if(!actor.isActive||actor.role!=="SUPER_ADMIN")throw new Error("Forbidden");const changed=await tx.operationsJob.updateMany({where:{key:data.key,state:"REVIEW"},data:{state:"RETRY",attempts:0,nextAttemptAt:new Date(),leaseToken:null,leaseExpiresAt:null}});if(changed.count)await tx.auditLog.create({data:{actorId:userId,action:"operations.review.retry",entityType:"OperationsJob",entityId:data.key,metadata:{reason:data.reason}}});return {retried:changed.count};});return Response.json(result);}
  return Response.json({error:"Invalid operation"},{status:400});
 }catch{return Response.json({error:"Operation refused. Check prerequisites and use a fresh security code."},{status:409});}
}
