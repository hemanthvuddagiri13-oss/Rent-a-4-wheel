import {staleWorkerCount} from "@/lib/worker-schedule";
import { randomUUID,createHash } from "node:crypto";
import type { OperationsJob,PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { scanWithClamAv,scannerVersion } from "@/lib/clamav";
import { readPrivateBytes,deletePrivateBytes } from "@/lib/storage";
import { safeLog } from "@/lib/safe-log";
import {assertOperationsLease,finishOperation,OperationsLeaseLost} from "@/lib/operations-lease";
export {finishOperation} from "@/lib/operations-lease";
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
export async function claimOperationsBatch(kind:string,db:PrismaClient=prisma){
 const review=await db.$executeRaw`UPDATE "OperationsJob" SET state='REVIEW',"lastErrorCode"='LEASE_EXHAUSTED',"leaseToken"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') WHERE kind=${kind} AND state='RUNNING' AND attempts>=5 AND "leaseExpiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC')`;
 const token=randomUUID();
 const jobs=await db.$queryRaw<OperationsJob[]>`UPDATE "OperationsJob" SET state='RUNNING',"leaseToken"=${token},"leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '2 minutes',attempts=attempts+1,"updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
 WHERE key IN (SELECT key FROM "OperationsJob" WHERE kind=${kind} AND attempts<5 AND "nextAttemptAt"<=(clock_timestamp() AT TIME ZONE 'UTC') AND (state IN ('PENDING','RETRY') OR state='RUNNING' AND "leaseExpiresAt"<(clock_timestamp() AT TIME ZONE 'UTC')) ORDER BY "nextAttemptAt","createdAt",key FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *`;
 return {jobs,review};
}
export async function claimOperations(kind:string,db:PrismaClient=prisma){return (await claimOperationsBatch(kind,db)).jobs;}
async function runScan(job:OperationsJob){
 const key=job.resourceId!;
 const row=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;await assertOperationsLease(tx,job);const current=await tx.privateObject.findUniqueOrThrow({where:{key}});if(["INFECTED","DELETING","DELETED"].includes(current.state))return null;await tx.privateObject.update({where:{key},data:{state:"SCANNING"}});return current;});
 if(!row)return {committed:Boolean((await finishOperation(job,"DONE")).count),quarantined:false};
 if(row.writeState!=="STORED")throw new Error("PRIVATE_WRITE_REQUIRES_REVIEW");
 const validation=await prisma.privateValidation.findUnique({where:{targetKey:key}});
 if(await prisma.operationsJob.count({where:{kind:"LEGACY_IMPORT",resourceId:key}})&&!validation)throw new Error("PRIVATE_CONTENT_VALIDATION_REQUIRED");
 if(validation&&(validation.targetSha256!==row.sha256||validation.mimeType!==row.mimeType||validation.bytes.length!==row.size))throw new Error("PRIVATE_CONTENT_VALIDATION_MISMATCH");
 const bytes=await readPrivateBytes(key);if(bytes.length!==row.size||hash(bytes)!==row.sha256)throw new Error("PRIVATE_OBJECT_INTEGRITY");
 const version=await scannerVersion(),result=await scanWithClamAv(bytes);if(result.status==="SCAN_UNAVAILABLE")throw new Error("SCANNER_UNAVAILABLE");
 return prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;
  if(validation&&validation.sourceKey!==key){
   const sources=await tx.$queryRaw<Array<{key:string}>>`SELECT key FROM "PrivateObject" WHERE key=${validation.sourceKey} AND "writeState"='STORED' AND "sha256"=${validation.sourceSha256} AND "deletedAt" IS NULL AND state NOT IN ('INFECTED','DELETING','DELETED') FOR UPDATE`;
   if(!sources.length)throw new Error("PRIVATE_VALIDATION_SOURCE_UNAVAILABLE");
  }
  const saved=await finishOperation(job,"DONE",undefined,tx);if(!saved.count)return {committed:false,quarantined:false};
  const projected=await tx.privateObject.updateMany({where:{key,state:"SCANNING",deletedAt:null},data:{state:result.status,scannedAt:new Date(),scanEngine:"ClamAV",scanVersion:version}});
  if(projected.count){
   await tx.driverDocument.updateMany({where:{storageKey:key,contentSha256:row.sha256,deletedAt:null,malwareScanStatus:{not:"INFECTED"}},data:{malwareScanStatus:result.status}});
   await tx.marketplaceFile.updateMany({where:{storageKey:key,sha256:row.sha256,scanStatus:{not:"INFECTED"}},data:{scanStatus:result.status}});
   await tx.collaborationFile.updateMany({where:{storageKey:key,sha256:row.sha256,deletedAt:null,scanStatus:{notIn:["INFECTED","DELETION_COMMITTED"]}},data:{scanStatus:result.status}});
   // Retain the original attachment identity and hash. Authorized downloads
   // resolve through immutable validation evidence to the sanitized object.
   if(validation&&validation.sourceKey!==key){
    if(validation.resourceType==="IDENTITY")await tx.driverDocument.updateMany({where:{id:validation.resourceId,storageKey:validation.sourceKey,contentSha256:validation.sourceSha256,deletedAt:null,malwareScanStatus:{not:"INFECTED"}},data:{malwareScanStatus:result.status}});
    if(validation.resourceType==="BUSINESS")await tx.marketplaceFile.updateMany({where:{id:validation.resourceId,storageKey:validation.sourceKey,sha256:validation.sourceSha256,scanStatus:{not:"INFECTED"}},data:{scanStatus:result.status}});
    if(validation.resourceType==="COLLABORATION")await tx.collaborationFile.updateMany({where:{id:validation.resourceId,storageKey:validation.sourceKey,sha256:validation.sourceSha256,deletedAt:null,scanStatus:{notIn:["INFECTED","DELETION_COMMITTED"]}},data:{scanStatus:result.status}});
   }
   await tx.auditLog.create({data:{action:result.status==="CLEAN"?"storage.scan.clean":"storage.scan.infected",entityType:"PrivateObject",entityId:hash(key)}});
  }
  return {committed:true,quarantined:result.status==="INFECTED"};
 });
}
export async function runOperations(kind:"SCAN"|"DELETE"|"AGREEMENT"){
 const batch=await claimOperationsBatch(kind),jobs=batch.jobs;let completed=0,failed=0,stale=0,review=batch.review,quarantined=0;
 for(const job of jobs)try{
  let committed=false;
  if(kind==="SCAN"){const result=await runScan(job);committed=result.committed;if(committed&&result.quarantined)quarantined++;}else if(kind==="AGREEMENT"){const {generateSignedAgreementArtifact}=await import("@/lib/agreement-artifact");committed=await generateSignedAgreementArtifact(job.resourceId!,job);}else{
   const object=await prisma.privateObject.findUnique({where:{key:job.resourceId!}});
   if(object&&object.state!=="DELETING"&&object.state!=="DELETED")throw new Error("DELETE_NOT_AUTHORIZED");
   await deletePrivateBytes(job.resourceId!);
   committed=await prisma.$transaction(async tx=>{const done=await finishOperation(job,"DONE",undefined,tx);if(!done.count)return false;await tx.privateObject.updateMany({where:{key:job.resourceId!,state:"DELETING"},data:{state:"DELETED"}});await tx.auditLog.create({data:{action:"storage.deleted",entityType:"PrivateObject",entityId:hash(job.resourceId!)}});return true;});
  }if(committed)completed++;else stale++;
 }catch(error){
  if(error instanceof OperationsLeaseLost){stale++;continue;}
  safeLog("OPERATIONS_RETRY",error);
  const committed=await prisma.$transaction(async tx=>{
   if(kind==="SCAN")await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+job.resourceId!},0))::text`;
   const update=await finishOperation(job,job.attempts>=5?"REVIEW":"RETRY",kind+"_FAILED",tx);
   if(update.count&&kind==="SCAN")await tx.privateObject.updateMany({where:{key:job.resourceId!,state:"SCANNING"},data:{state:"SCAN_FAILED"}});
   return Boolean(update.count);
  });
  if(!committed)stale++;else{failed++;if(kind==="SCAN")quarantined++;if(job.attempts>=5)review++;}
 }
 return {claimed:jobs.length,processed:completed+failed,completed,failed,quarantined,review,stale};
}
export async function operationalMetrics(){
 const [uncertain,refunds,deposits,payoutHolds,outbox,scanFailures,deletionFailures,overdueCases,uncertainWrites,staleWorkers,agreementFailures,retentionFailures,operatorReviews]=await Promise.all([
 prisma.financialOperation.count({where:{state:{in:["REVIEW","DEAD_LETTER"]}}}),prisma.refund.count({where:{status:"FAILED"}}),prisma.financialOperation.count({where:{kind:"DEPOSIT_RELEASE",state:{notIn:["OBSERVED"]}}}),prisma.financeIssue.count({where:{status:{not:"RESOLVED"}}}),prisma.outboxMessage.count({where:{status:{in:["PENDING","FAILED"]}}}),prisma.operationsJob.count({where:{kind:"SCAN",state:{in:["RETRY","REVIEW"]}}}),prisma.operationsJob.count({where:{kind:"DELETE",state:{in:["RETRY","REVIEW"]}}}),prisma.serviceCase.count({where:{state:{not:"CLOSED"},dueAt:{lt:new Date()}}}),prisma.privateObject.count({where:{writeState:{in:["UNCERTAIN","RUNNING"]}}}),staleWorkerCount(),prisma.operationsJob.count({where:{kind:"AGREEMENT",state:{in:["RETRY","REVIEW"]}}}),prisma.storageDeletionJob.count({where:{state:"DEAD_LETTER"}}),prisma.operationsJob.count({where:{kind:{in:["ALERT","LEGACY_IMPORT"]},state:{in:["RETRY","REVIEW"]}}})]);return {uncertain,refunds,deposits,payoutHolds,outbox,scanFailures,deletionFailures,overdueCases,uncertainWrites,staleWorkers,agreementFailures,retentionFailures,operatorReviews};
}
