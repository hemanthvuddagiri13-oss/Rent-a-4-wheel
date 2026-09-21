import {z} from "zod";
import {createHash} from "node:crypto";
import type {Prisma} from "@prisma/client";
import {protectedAdminMutation,assertAdminExecution,type AdminExecution} from "@/lib/protected-admin";
import {withPrivateStorageGuard} from "@/lib/private-storage-guard";
import {readPrivateBytes,storePrivateDocument,planPrivateDocument} from "@/lib/storage";
import {validatePrivateContent} from "@/lib/private-content-validation";
import {json} from "@/lib/financial-operations";
const schema=z.object({action:z.literal("importLegacyObject"),resourceType:z.enum(["IDENTITY","BUSINESS","CONDITION","AGREEMENT","COLLABORATION"]),resourceId:z.string().min(1).max(100),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(8*1024*1024),mimeType:z.enum(["image/jpeg","image/png","image/webp","application/pdf"]),code:z.string().regex(/^\d{6}$/),reason:z.string().trim().min(10).max(500),confirm:z.literal(true)}).strict();
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
 // A validation applies to one authorized resource, not to every attachment
 // that happens to reuse its provider key. Ambiguous legacy aliases require
 // operator review before any provider read or quarantine release.
 const aliases=await Promise.all([
  tx.driverDocument.count({where:{storageKey:key,...(input.resourceType==="IDENTITY"?{id:{not:input.resourceId}}:{})}}),
  tx.marketplaceFile.count({where:{storageKey:key,...(input.resourceType==="BUSINESS"?{id:{not:input.resourceId}}:{})}}),
  tx.conditionPhoto.count({where:{storageKey:key,...(input.resourceType==="CONDITION"?{id:{not:input.resourceId}}:{})}}),
  tx.agreementAcceptance.count({where:{signedPdfStorageKey:key,...(input.resourceType==="AGREEMENT"?{id:{not:input.resourceId}}:{})}}),
  tx.collaborationFile.count({where:{storageKey:key,...(input.resourceType==="COLLABORATION"?{id:{not:input.resourceId}}:{})}}),
 ]);
 if(aliases.some(Boolean))throw new Error("IMPORT_AMBIGUOUS_RESOURCE");
 return key;
}
/** Narrow security operation: known attached objects only, never arbitrary URLs.
 * Preserves the original key; reads verified bytes and queues a fresh scan.
 * Import is not evidence of provider-at-rest encryption or a retention approval.
 */
export async function importLegacyPrivateObject(userId:string,raw:unknown,execution:AdminExecution){
 const input=schema.parse(raw);
 const key=await protectedAdminMutation(userId,input,execution,"legacy-import",async tx=>{
  const key=await source(tx,input),jobKey="legacy-import:"+hash(key);
  if(await tx.operationsJob.count({where:{key:"delete:"+hash(key)}}))throw new Error("IMPORT_DELETION_COMMITTED");
  const old=await tx.privateObject.findUnique({where:{key}}),intent=await tx.operationsJob.findUnique({where:{key:jobKey}});
  if(old&&(!intent||old.sha256!==input.sha256||old.size!==input.size||old.mimeType!==input.mimeType||!["PREPARED","STORED"].includes(old.writeState)||["INFECTED","DELETING","DELETED"].includes(old.state)))throw new Error("IMPORT_EXISTING_MANIFEST_REQUIRES_REVIEW");
  if(intent){const p=intent.payload as {resourceType:string;resourceId:string};if(p.resourceType!==input.resourceType||p.resourceId!==input.resourceId)throw new Error("IMPORT_EVIDENCE_MISMATCH");}
  if(!old){await tx.privateObject.create({data:{key,sha256:input.sha256,size:input.size,mimeType:input.mimeType,hold:true}});await tx.operationsJob.create({data:{key:jobKey,kind:"LEGACY_IMPORT",resourceId:key,state:"REVIEW",payload:{resourceType:input.resourceType,resourceId:input.resourceId,sha256:input.sha256,size:input.size,mimeType:input.mimeType},lastErrorCode:"IMPORT_BYTES_NOT_VERIFIED"}});}
  return key;
 });
 const jobKey="legacy-import:"+hash(key);
 return withPrivateStorageGuard(key,async db=>{
  await db.$transaction(tx=>assertAdminExecution(tx,userId,execution));
  let validation=await db.privateValidation.findUnique({where:{sourceKey:key}});
  if(!validation){
   const bytes=await readPrivateBytes(key);if(bytes.length!==input.size||hash(bytes)!==input.sha256)throw new Error("IMPORT_EVIDENCE_MISMATCH");
   const validated=await validatePrivateContent(bytes,input.mimeType,input.resourceType);
   const targetKey=input.mimeType==="application/pdf"?key:planPrivateDocument(validated.mimeType,"validated-"+hash(key)).storageKey;
   validation=await db.privateValidation.create({data:{sourceKey:key,targetKey,resourceType:input.resourceType,resourceId:input.resourceId,sourceSha256:input.sha256,targetSha256:validated.sha256,mimeType:validated.mimeType,bytes:Buffer.from(validated.bytes),evidence:json(validated.evidence)}});
  }
  if(validation.targetKey!==key){
   const stored=await storePrivateDocument(Buffer.from(validation.bytes),validation.mimeType,"validated-"+hash(key),{hold:true});
   if(stored.storageKey!==validation.targetKey)throw new Error("IMPORT_TARGET_CHANGED");
  }
  await db.$transaction(async tx=>{
   await assertAdminExecution(tx,userId,execution);
   if(await source(tx,input)!==key)throw new Error("IMPORT_SOURCE_CHANGED");
   await tx.privateObject.update({where:{key},data:{writeState:"STORED",state:"QUARANTINED"}});
   const scanKey=validation!.targetKey;
   await tx.operationsJob.upsert({where:{key:"scan:"+hash(scanKey)},create:{key:"scan:"+hash(scanKey),kind:"SCAN",resourceId:scanKey},update:{state:"PENDING",attempts:0,nextAttemptAt:new Date(0)}});
   await tx.operationsJob.update({where:{key:jobKey},data:{state:"DONE",lastErrorCode:null}});
   await tx.auditLog.create({data:{actorId:userId,action:"storage.legacy.quarantined",entityType:"PrivateObject",entityId:hash(key)}});
  });return {quarantined:true,held:true};
 });
}
