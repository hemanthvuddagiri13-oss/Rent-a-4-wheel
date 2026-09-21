import {staleWorkerCount} from "@/lib/worker-schedule";
import { randomUUID,createHash } from "node:crypto";
import type { OperationsJob,PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { scanWithClamAv,scannerVersion } from "@/lib/clamav";
import { readPrivateBytes,deletePrivateBytes } from "@/lib/storage";
import { safeLog } from "@/lib/safe-log";
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
export async function claimOperations(kind:string,db:PrismaClient=prisma){
 await db.operationsJob.updateMany({where:{kind,state:"RUNNING",attempts:{gte:5},leaseExpiresAt:{lt:new Date()}},data:{state:"REVIEW",lastErrorCode:"LEASE_EXHAUSTED",leaseToken:null,leaseExpiresAt:null}});
 const token=randomUUID();
 return db.$queryRaw<OperationsJob[]>`UPDATE "OperationsJob" SET state='RUNNING',"leaseToken"=${token},"leaseExpiresAt"=CURRENT_TIMESTAMP+interval '2 minutes',attempts=attempts+1,"updatedAt"=CURRENT_TIMESTAMP
 WHERE key IN (SELECT key FROM "OperationsJob" WHERE kind=${kind} AND attempts<5 AND "nextAttemptAt"<=CURRENT_TIMESTAMP AND (state IN ('PENDING','RETRY') OR state='RUNNING' AND "leaseExpiresAt"<CURRENT_TIMESTAMP) ORDER BY "nextAttemptAt","createdAt",key FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *`;
}
export async function finishOperation(job:OperationsJob,state:"DONE"|"RETRY"|"REVIEW",error?:string,db:PrismaClient=prisma){
 return db.operationsJob.updateMany({where:{key:job.key,state:"RUNNING",leaseToken:job.leaseToken,leaseExpiresAt:{gt:new Date()}},data:{state,leaseToken:null,leaseExpiresAt:null,lastErrorCode:error??null,nextAttemptAt:new Date(Date.now()+Math.min(3600000,60000*2**job.attempts))}});
}
async function runScan(job:OperationsJob){
 const key=job.resourceId!;
 const row=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;const current=await tx.privateObject.findUniqueOrThrow({where:{key}});if(["INFECTED","DELETING","DELETED"].includes(current.state))return null;if(!await tx.operationsJob.count({where:{key:job.key,leaseToken:job.leaseToken,state:"RUNNING",leaseExpiresAt:{gt:new Date()}}}))throw new Error("LEASE_LOST");await tx.privateObject.update({where:{key},data:{state:"SCANNING"}});return current;});
 if(!row){await finishOperation(job,"DONE");return;}
 if(row.writeState!=="STORED")throw new Error("PRIVATE_WRITE_REQUIRES_REVIEW");
 const bytes=await readPrivateBytes(key);if(bytes.length!==row.size||hash(bytes)!==row.sha256)throw new Error("PRIVATE_OBJECT_INTEGRITY");
 const version=await scannerVersion(),result=await scanWithClamAv(bytes);if(result.status==="SCAN_UNAVAILABLE")throw new Error("SCANNER_UNAVAILABLE");
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;
  const saved=await tx.operationsJob.updateMany({where:{key:job.key,state:"RUNNING",leaseToken:job.leaseToken,leaseExpiresAt:{gt:new Date()}},data:{state:"DONE",leaseToken:null,leaseExpiresAt:null}});if(!saved.count)return;
  const projected=await tx.privateObject.updateMany({where:{key,state:"SCANNING",deletedAt:null},data:{state:result.status,scannedAt:new Date(),scanEngine:"ClamAV",scanVersion:version}});
  if(projected.count){
   await tx.driverDocument.updateMany({where:{storageKey:key,contentSha256:row.sha256,deletedAt:null,malwareScanStatus:{not:"INFECTED"}},data:{malwareScanStatus:result.status}});
   await tx.marketplaceFile.updateMany({where:{storageKey:key,sha256:row.sha256,scanStatus:{not:"INFECTED"}},data:{scanStatus:result.status}});
   await tx.collaborationFile.updateMany({where:{storageKey:key,sha256:row.sha256,deletedAt:null,scanStatus:{notIn:["INFECTED","DELETION_COMMITTED"]}},data:{scanStatus:result.status}});
   await tx.auditLog.create({data:{action:result.status==="CLEAN"?"storage.scan.clean":"storage.scan.infected",entityType:"PrivateObject",entityId:hash(key)}});
  }
 });
}
export async function runOperations(kind:"SCAN"|"DELETE"|"AGREEMENT"){
 // A worker crashing on its last allowed attempt becomes visible for review.
 await prisma.operationsJob.updateMany({where:{kind,state:"RUNNING",attempts:{gte:5},leaseExpiresAt:{lt:new Date()}},data:{state:"REVIEW",lastErrorCode:"LEASE_EXHAUSTED",leaseToken:null}});
 const jobs=await claimOperations(kind);let completed=0,failed=0;
 for(const job of jobs)try{
  if(kind==="SCAN")await runScan(job);else if(kind==="AGREEMENT"){const {generateSignedAgreementArtifact}=await import("@/lib/agreement-artifact");await generateSignedAgreementArtifact(job.resourceId!);await finishOperation(job,"DONE");}else{
   const object=await prisma.privateObject.findUnique({where:{key:job.resourceId!}});
   if(object&&object.state!=="DELETING"&&object.state!=="DELETED")throw new Error("DELETE_NOT_AUTHORIZED");
   await deletePrivateBytes(job.resourceId!);
   await prisma.$transaction(async tx=>{const done=await tx.operationsJob.updateMany({where:{key:job.key,state:"RUNNING",leaseToken:job.leaseToken,leaseExpiresAt:{gt:new Date()}},data:{state:"DONE",leaseToken:null,leaseExpiresAt:null}});if(done.count){await tx.privateObject.updateMany({where:{key:job.resourceId!,state:"DELETING"},data:{state:"DELETED"}});await tx.auditLog.create({data:{action:"storage.deleted",entityType:"PrivateObject",entityId:hash(job.resourceId!)}});}});
  }completed++;
 }catch(error){failed++;safeLog("OPERATIONS_RETRY",error);await prisma.$transaction(async tx=>{const update=await tx.operationsJob.updateMany({where:{key:job.key,state:"RUNNING",leaseToken:job.leaseToken,leaseExpiresAt:{gt:new Date()}},data:{state:job.attempts>=5?"REVIEW":"RETRY",leaseToken:null,leaseExpiresAt:null,lastErrorCode:kind==="SCAN"?"SCAN_FAILED":kind==="AGREEMENT"?"AGREEMENT_FAILED":"DELETE_FAILED",nextAttemptAt:new Date(Date.now()+60000*2**job.attempts)}});if(update.count&&kind==="SCAN")await tx.privateObject.updateMany({where:{key:job.resourceId!,state:"SCANNING"},data:{state:"SCAN_FAILED"}});});}
 return {claimed:jobs.length,completed,failed};
}
export async function operationalMetrics(){
 const [uncertain,refunds,deposits,payoutHolds,outbox,scanFailures,deletionFailures,overdueCases,uncertainWrites,staleWorkers,agreementFailures,retentionFailures,operatorReviews]=await Promise.all([
 prisma.financialOperation.count({where:{state:{in:["REVIEW","DEAD_LETTER"]}}}),prisma.refund.count({where:{status:"FAILED"}}),prisma.financialOperation.count({where:{kind:"DEPOSIT_RELEASE",state:{notIn:["OBSERVED"]}}}),prisma.financeIssue.count({where:{status:{not:"RESOLVED"}}}),prisma.outboxMessage.count({where:{status:{in:["PENDING","FAILED"]}}}),prisma.operationsJob.count({where:{kind:"SCAN",state:{in:["RETRY","REVIEW"]}}}),prisma.operationsJob.count({where:{kind:"DELETE",state:{in:["RETRY","REVIEW"]}}}),prisma.serviceCase.count({where:{state:{not:"CLOSED"},dueAt:{lt:new Date()}}}),prisma.privateObject.count({where:{writeState:{in:["UNCERTAIN","RUNNING"]}}}),staleWorkerCount(),prisma.operationsJob.count({where:{kind:"AGREEMENT",state:{in:["RETRY","REVIEW"]}}}),prisma.storageDeletionJob.count({where:{state:"DEAD_LETTER"}}),prisma.operationsJob.count({where:{kind:{in:["ALERT","LEGACY_IMPORT"]},state:{in:["RETRY","REVIEW"]}}})]);return {uncertain,refunds,deposits,payoutHolds,outbox,scanFailures,deletionFailures,overdueCases,uncertainWrites,staleWorkers,agreementFailures,retentionFailures,operatorReviews};
}
