import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetPublicAccessBlockCommand, GetBucketEncryptionCommand, GetBucketPolicyStatusCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
function client(){return new S3Client({region:process.env.PRIVATE_STORAGE_REGION,endpoint:process.env.PRIVATE_STORAGE_ENDPOINT,forcePathStyle:true,maxAttempts:2,credentials:{accessKeyId:process.env.PRIVATE_STORAGE_ACCESS_KEY_ID!,secretAccessKey:process.env.PRIVATE_STORAGE_SECRET_ACCESS_KEY!}});}
const bucket=()=>process.env.PRIVATE_STORAGE_BUCKET!;
function objectKey(key:string){if(!/^s3:[a-zA-Z0-9-]+\.[a-z0-9]+$/.test(key))throw new Error("INVALID_PRIVATE_KEY");return key.slice(3);}
export async function verifyPrivateBucket(){
 const s3=client();try{const [access,encryption,policy]=await Promise.all([s3.send(new GetPublicAccessBlockCommand({Bucket:bucket()})),s3.send(new GetBucketEncryptionCommand({Bucket:bucket()})),s3.send(new GetBucketPolicyStatusCommand({Bucket:bucket()}))]);
 const a=access.PublicAccessBlockConfiguration;
 if(!a?.BlockPublicAcls||!a.IgnorePublicAcls||!a.BlockPublicPolicy||!a.RestrictPublicBuckets||policy.PolicyStatus?.IsPublic!==false||!encryption.ServerSideEncryptionConfiguration?.Rules?.some(r=>r.ApplyServerSideEncryptionByDefault?.SSEAlgorithm==="aws:kms"&&r.ApplyServerSideEncryptionByDefault.KMSMasterKeyID===process.env.PRIVATE_STORAGE_KMS_KEY_ID))throw new Error("PRIVATE_BUCKET_UNSAFE");return true;
 }finally{s3.destroy();}
}
export async function readS3Private(key:string){const s3=client();try{const result=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:objectKey(key),ChecksumMode:"ENABLED"}));if(!result.Body||result.ServerSideEncryption!=="aws:kms")throw new Error("PRIVATE_OBJECT_INVALID");if(!result.ContentLength||result.ContentLength>16*1024*1024)throw new Error("PRIVATE_OBJECT_SIZE");const chunks:Uint8Array[]=[];let size=0;for await(const chunk of result.Body as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>16*1024*1024)throw new Error("PRIVATE_OBJECT_SIZE");chunks.push(chunk);}return Buffer.concat(chunks);}finally{s3.destroy();}}
export async function putS3Private(key:string,buffer:Buffer,mimeType:string){
 await verifyPrivateBucket();const s3=client();try{await s3.send(new PutObjectCommand({Bucket:bucket(),Key:objectKey(key),Body:buffer,ContentLength:buffer.length,ContentType:mimeType,IfNoneMatch:"*",ServerSideEncryption:"aws:kms",SSEKMSKeyId:process.env.PRIVATE_STORAGE_KMS_KEY_ID,ChecksumSHA256:createHash("sha256").update(buffer).digest("base64"),Metadata:{sha256:createHash("sha256").update(buffer).digest("hex")}}));}
 catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw new Error("PRIVATE_WRITE_FAILED");const stored=await readS3Private(key);if(!stored.equals(buffer))throw new Error("PRIVATE_OBJECT_CONFLICT");}finally{s3.destroy();}
}
export async function deleteS3Private(key:string){
 const s3=client(),Key=objectKey(key);try{
  // Delete exact-key versions too; a delete marker alone is not erasure.
  for(let page=0;page<10;page++){const list=await s3.send(new ListObjectVersionsCommand({Bucket:bucket(),Prefix:Key,MaxKeys:100}));const versions=[...(list.Versions??[]),...(list.DeleteMarkers??[])].filter(v=>v.Key===Key);if(!versions.length){await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key}));return;}for(const version of versions)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key,VersionId:version.VersionId}));}
  throw new Error("PRIVATE_DELETE_REMAINS_PENDING");
 }finally{s3.destroy();}
}
