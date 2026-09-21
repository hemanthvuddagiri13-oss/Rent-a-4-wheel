import {z} from "zod";
import {createHash} from "node:crypto";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/lib/prisma";
import {securityStepUp} from "@/lib/release-control";
import {withPrivateStorageGuard} from "@/lib/private-storage-guard";
import {readPrivateBytes} from "@/lib/storage";
const schema=z.object({action:z.literal("importLegacyObject"),resourceType:z.enum(["IDENTITY","BUSINESS","CONDITION","AGREEMENT","COLLABORATION"]),resourceId:z.string().min(1).max(100),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(8*1024*1024),mimeType:z.enum(["image/jpeg","image/png","image/webp","application/pdf"]),code:z.string().regex(/^\d{6}$/),reason:z.string().trim().min(10).max(500)}).strict();
type ImportInput=z.infer<typeof schema>;
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
async function source(tx:Prisma.TransactionClient,input:ImportInput){
 let key:string|null=null,sha:string|null=null,mime:string|null=null,size:number|null=null;
 if(input.resourceType==="IDENTITY"){const row=await tx.driverDocument.findUniqueOrThrow({where:{id:input.resourceId}});if(row.deletedAt||row.malwareScanStatus==="INFECTED")throw new Error("IMPORT_REFUSED");key=row.storageKey;sha=row.contentSha256;mime=row.mimeType;size=row.fileSizeBytes;}
 if(input.resourceType==="BUSINESS"){const row=await tx.marketplaceFile.findUniqueOrThrow({where:{id:input.resourceId}});if(row.scanStatus==="INFECTED")throw new Error("IMPORT_REFUSED");key=row.storageKey;sha=row.sha256;mime=row.mimeType;}
 if(input.resourceType==="CONDITION"){key=(await tx.conditionPhoto.findUniqueOrThrow({where:{id:input.resourceId}})).storageKey;if(input.mimeType==="application/pdf")throw new Error("IMPORT_REFUSED");}
 if(input.resourceType==="AGREEMENT"){key=(await tx.agreementAcceptance.findUniqueOrThrow({where:{id:input.resourceId}})).signedPdfStorageKey;mime="application/pdf";}
 if(input.resourceType==="COLLABORATION"){const row=await tx.collaborationFile.findUniqueOrThrow({where:{id:input.resourceId}});if(row.deletedAt||["INFECTED","DELETION_COMMITTED"].includes(row.scanStatus))throw new Error("IMPORT_REFUSED");key=row.storageKey;sha=row.sha256;mime=row.mimeType;size=row.size;}
 if(!key||!key.startsWith("s3:")&&!key.startsWith("cloudinary:")||sha&&sha!==input.sha256||mime&&mime!==input.mimeType||size!==null&&size!==input.size)throw new Error("IMPORT_EVIDENCE_MISMATCH");
 return key;
}
/** Narrow security operation: known attached objects only, never arbitrary URLs.
 * Preserves the original key; reads verified bytes and queues a fresh scan.
 * Import is not evidence of provider-at-rest encryption or a retention approval.
 */
export async function importLegacyPrivateObject(userId:string,raw:unknown){
 const input=schema.parse(raw);await securityStepUp(userId,input.code);const key=await source(prisma,input),jobKey="legacy-import:"+hash(key);
 return withPrivateStorageGuard(key,async db=>{
  await db.$transaction(async tx=>{
   const actor=await tx.user.findUniqueOrThrow({where:{id:userId}});if(!actor.isActive||actor.role!=="SUPER_ADMIN"||await source(tx,input)!==key)throw new Error("IMPORT_REFUSED");
   if(await tx.operationsJob.count({where:{key:"delete:"+hash(key)}}))throw new Error("IMPORT_DELETION_COMMITTED");
   const old=await tx.privateObject.findUnique({where:{key}}),intent=await tx.operationsJob.findUnique({where:{key:jobKey}});
   if(old&&(!intent||old.sha256!==input.sha256||old.size!==input.size||old.mimeType!==input.mimeType||old.writeState!=="PREPARED"||old.state!=="UPLOADED"))throw new Error("IMPORT_EXISTING_MANIFEST_REQUIRES_REVIEW");
   if(!old){await tx.privateObject.create({data:{key,sha256:input.sha256,size:input.size,mimeType:input.mimeType,hold:true}});await tx.operationsJob.create({data:{key:jobKey,kind:"LEGACY_IMPORT",resourceId:key,state:"REVIEW",payload:{resourceType:input.resourceType,resourceId:input.resourceId,sha256:input.sha256,size:input.size,mimeType:input.mimeType},lastErrorCode:"IMPORT_BYTES_NOT_VERIFIED"}});}
   await tx.auditLog.create({data:{actorId:userId,action:"storage.legacy.import.intent",entityType:"PrivateObject",entityId:hash(key),metadata:{reason:input.reason}}});
  });
  const bytes=await readPrivateBytes(key);if(bytes.length!==input.size||hash(bytes)!==input.sha256)throw new Error("IMPORT_EVIDENCE_MISMATCH");
  await db.$transaction(async tx=>{
   if(await source(tx,input)!==key)throw new Error("IMPORT_SOURCE_CHANGED");
   await tx.privateObject.update({where:{key},data:{writeState:"STORED",state:"QUARANTINED"}});
   await tx.operationsJob.upsert({where:{key:"scan:"+hash(key)},create:{key:"scan:"+hash(key),kind:"SCAN",resourceId:key},update:{}});
   await tx.operationsJob.update({where:{key:jobKey},data:{state:"DONE",lastErrorCode:null}});
   await tx.auditLog.create({data:{actorId:userId,action:"storage.legacy.quarantined",entityType:"PrivateObject",entityId:hash(key)}});
  });return {quarantined:true,held:true};
 });
}
