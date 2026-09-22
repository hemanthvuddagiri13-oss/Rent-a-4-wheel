import {z} from "zod";
import type {Prisma,PrismaClient} from "@prisma/client";
import {prisma} from "@/lib/prisma";
import {verifyAuthCode} from "@/lib/auth-code";
import {requestOriginAllowed} from "@/lib/security-request";
import {releaseAuthorityFence} from "@/lib/admission-authority";

export const adminProofSchema=z.object({code:z.string().regex(/^\d{6}$/),confirm:z.literal(true),reason:z.string().trim().min(10).max(500)});
export type AdminExecution={userId:string;sessionId:string;credentialVersion:number;headers:Headers};
export function adminExecution(session:unknown,headers:Headers):AdminExecution{
 const s=z.object({user:z.object({id:z.string().min(1)}),sessionId:z.string().min(1),credentialVersion:z.number().int().nonnegative()}).parse(session);
 return {userId:s.user.id,sessionId:s.sessionId,credentialVersion:s.credentialVersion,headers};
}
export function formAdminProof(form:FormData){return {code:String(form.get("code")??""),confirm:form.get("confirm")==="true",reason:String(form.get("reason")??"")};}
export async function assertAdminExecution(tx:Prisma.TransactionClient,userId:string,execution:AdminExecution){
 if(!execution||execution.userId!==userId||!execution.headers.get("origin")||!requestOriginAllowed(new Request(execution.headers.get("origin")!+"/api/admin/operations",{headers:execution.headers})))throw new Error("ADMIN_AUTHORITY_REQUIRED");
 await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
 const actor=await tx.user.findUnique({where:{id:userId}});
 if(!actor?.isActive||actor.role!=="SUPER_ADMIN")throw new Error("ADMIN_AUTHORITY_REQUIRED");
 const rows=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "Session" WHERE id=${execution.sessionId} AND "userId"=${userId} AND rotation=${execution.credentialVersion} AND "revokedAt" IS NULL AND expires>(clock_timestamp() AT TIME ZONE 'UTC') AND "lastSeenAt">(clock_timestamp() AT TIME ZONE 'UTC')-interval '30 minutes' FOR UPDATE`;
 if(!rows.length)throw new Error("ADMIN_AUTHORITY_REQUIRED");
 return actor;
}
export async function protectedAdminMutation<T>(userId:string,proof:unknown,execution:AdminExecution,action:string,run:(tx:Prisma.TransactionClient)=>Promise<T>,db:PrismaClient=prisma):Promise<T>{
 try{
  const parsed=adminProofSchema.parse(proof);
  // Reject origins and stale credentials before consuming a code; repeat inside
  // the committing transaction to cover revocation while waiting for authority.
  const actor=await db.$transaction(tx=>assertAdminExecution(tx,userId,execution));
  if(!(await verifyAuthCode({email:actor.email,code:parsed.code,ip:null,purpose:"SECURITY_STEP_UP"})).ok)throw new Error("ADMIN_AUTHORITY_REQUIRED");
  return await db.$transaction(async tx=>{
   await releaseAuthorityFence(tx,true);
   await assertAdminExecution(tx,userId,execution);
   const result=await run(tx);
   await tx.auditLog.create({data:{actorId:userId,action:"protected.admin."+action,entityType:"AdministrativeMutation",entityId:execution.sessionId,metadata:{reason:parsed.reason,confirmed:true}}});
   return result;
  },{timeout:20000,maxWait:15000});
 }catch{throw new Error("ADMIN_MUTATION_REFUSED");}
}
