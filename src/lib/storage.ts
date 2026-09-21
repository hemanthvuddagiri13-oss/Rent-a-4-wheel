import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { v2 as cloudinary } from "cloudinary";
import { prisma } from "@/lib/prisma";
import { localDevelopment } from "@/lib/deployment-environment";
import { putS3Private, readS3Private, deleteS3Private } from "@/lib/s3-private";
const ROOT=path.join(process.cwd(),"private-storage","documents");
const hash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});
export interface StoredDocument {storageKey:string}
function localPath(key:string){if(!/^local:[a-zA-Z0-9-]+\.[a-z0-9]+$/.test(key))throw new Error("INVALID_PRIVATE_STORAGE_KEY");return path.join(ROOT,key.slice(6));}
export function planPrivateDocument(mimeType:string,stableId:string):StoredDocument {
 if(!/^[a-zA-Z0-9-]+$/.test(stableId))throw new Error("INVALID_PRIVATE_STORAGE_ID");
 const ext=({"image/jpeg":"jpeg","image/png":"png","image/webp":"webp","application/pdf":"pdf"} as Record<string,string>)[mimeType];if(!ext)throw new Error("INVALID_PRIVATE_CONTENT_TYPE");
 const s3=process.env.PRIVATE_STORAGE_PROVIDER==="s3";if(!s3&&!localDevelopment())throw new Error("PRIVATE_STORAGE_UNAVAILABLE");
 return {storageKey:`${s3?"s3":"local"}:${stableId}.${ext}`};
}
export async function storePrivateDocument(buffer:Buffer,mimeType:string,stableId=randomUUID()):Promise<StoredDocument>{
 if(!buffer.length||buffer.length>16*1024*1024)throw new Error("PRIVATE_OBJECT_SIZE");
 const {storageKey:key}=planPrivateDocument(mimeType,stableId),sha256=hash(buffer);
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;
  const old=await tx.privateObject.findUnique({where:{key}});
  if(old&&(old.sha256!==sha256||old.size!==buffer.length||old.mimeType!==mimeType||old.deletedAt||["DELETING","DELETED","INFECTED"].includes(old.state)))throw new Error("PRIVATE_OBJECT_CONFLICT");
  if(!old){await tx.privateObject.create({data:{key,sha256,size:buffer.length,mimeType}});if(key.startsWith("s3:"))await tx.operationsJob.create({data:{key:"scan:"+hash(key),kind:"SCAN",resourceId:key,nextAttemptAt:new Date(Date.now()+120000)}});await tx.auditLog.create({data:{action:"storage.write.intent",entityType:"PrivateObject",entityId:hash(key)}});}
 });
 if(key.startsWith("s3:"))await putS3Private(key,buffer,mimeType);
 else{await mkdir(ROOT,{recursive:true});try{await writeFile(localPath(key),buffer,{flag:"wx"});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST"||!(await readFile(localPath(key))).equals(buffer))throw new Error("PRIVATE_WRITE_FAILED");}}
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;
  const row=await tx.privateObject.findUniqueOrThrow({where:{key}});if(row.state!=="UPLOADED")return;
  const fixture=localDevelopment()&&key.startsWith("local:");
  await tx.privateObject.update({where:{key},data:{state:fixture?"CLEAN":"QUARANTINED",...(fixture?{scanEngine:"DEVELOPMENT_FIXTURE",scanVersion:"not-a-provider-scan",scannedAt:new Date()}:{})}});
  if(!fixture)await tx.operationsJob.upsert({where:{key:"scan:"+hash(key)},create:{key:"scan:"+hash(key),kind:"SCAN",resourceId:key},update:{}});
  await tx.auditLog.create({data:{action:"storage.write.completed",entityType:"PrivateObject",entityId:hash(key)}});
 });return {storageKey:key};
}
/** Internal scanner access only. Route handlers must use readPrivateDocument after authorization. */
export async function readPrivateBytes(key:string){
 if(key.startsWith("s3:"))return readS3Private(key);
 if(key.startsWith("local:")){if(!localDevelopment())throw new Error("PRIVATE_STORAGE_UNAVAILABLE");return readFile(localPath(key));}
 if(!key.startsWith("cloudinary:")||!/^cloudinary:[a-zA-Z0-9_/-]+$/.test(key))throw new Error("INVALID_PRIVATE_STORAGE_KEY");
 const url=cloudinary.utils.private_download_url(key.slice(11),"",{resource_type:"image",type:"authenticated",expires_at:Math.floor(Date.now()/1000)+60});
 const response=await fetch(url,{signal:AbortSignal.timeout(10000),cache:"no-store"});if(!response.ok)throw new Error("PRIVATE_READ_FAILED");
 const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();if(!reader)throw new Error("PRIVATE_READ_FAILED");try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16*1024*1024){void reader.cancel();throw new Error("PRIVATE_OBJECT_SIZE");}chunks.push(part.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks);
}
export async function readPrivateDocument(key:string):Promise<{buffer:Buffer}>{
 const row=await prisma.privateObject.findUnique({where:{key}});
 if((!row&&!localDevelopment())||row&&(row.state!=="CLEAN"||row.deletedAt||!localDevelopment()&&row.scanEngine==="DEVELOPMENT_FIXTURE"))throw new Error("PRIVATE_OBJECT_NOT_CLEAN");
 const buffer=await readPrivateBytes(key);if(row&&(buffer.length!==row.size||hash(buffer)!==row.sha256))throw new Error("PRIVATE_OBJECT_INTEGRITY");
 await prisma.auditLog.create({data:{action:"storage.read",entityType:"PrivateObject",entityId:hash(key)}});
 return {buffer};
}
export async function deletePrivateDocument(key:string){
 const shouldDelete=await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"private:"+key},0))::text`;
  const row=await tx.privateObject.findUnique({where:{key}});if(row?.state==="DELETED")return false;
  if(row?.state!=="DELETING"&&row&&(row.hold||row.retainedUntil&&row.retainedUntil>new Date()))throw new Error("PRIVATE_OBJECT_HELD");
  if(row)await tx.privateObject.update({where:{key},data:{state:"DELETING",deletedAt:new Date()}});
  await tx.operationsJob.upsert({where:{key:"delete:"+hash(key)},create:{key:"delete:"+hash(key),kind:"DELETE",resourceId:key},update:{}});
  await tx.auditLog.create({data:{action:"storage.delete.intent",entityType:"PrivateObject",entityId:hash(key)}});return true;
 });
 if(!shouldDelete)return;
 await deletePrivateBytes(key);
 await prisma.$transaction(async tx=>{await tx.privateObject.updateMany({where:{key,state:"DELETING"},data:{state:"DELETED"}});await tx.operationsJob.updateMany({where:{key:"delete:"+hash(key)},data:{state:"DONE"}});await tx.auditLog.create({data:{action:"storage.deleted",entityType:"PrivateObject",entityId:hash(key)}});});
}
export async function deletePrivateBytes(key:string){
 if(key.startsWith("s3:")){await deleteS3Private(key);return;}
 if(key.startsWith("cloudinary:")){const result=await cloudinary.uploader.destroy(key.slice(11),{resource_type:"image",type:"authenticated",invalidate:true});if(!["ok","not found"].includes(result.result))throw new Error("PRIVATE_DELETE_NOT_ACCEPTED");return;}
 if(!localDevelopment())throw new Error("PRIVATE_STORAGE_UNAVAILABLE");
 await unlink(localPath(key)).catch(error=>{if(error.code!=="ENOENT")throw error;});
}
