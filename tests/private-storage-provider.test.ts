import {beforeAll,afterAll,afterEach,it,expect,vi} from "vitest";
import {createServer,type Server} from "node:http";
import {createServer as createScanner,type Server as ScannerServer,type Socket} from "node:net";
import {createHash,randomUUID} from "node:crypto";
import {verifyPrivateBucket,putS3Private,readS3Private,deleteS3Private} from "@/lib/s3-private";
import {storePrivateDocument,readPrivateDocument,deletePrivateDocument} from "@/lib/storage";
import {runOperations} from "@/lib/operations";
import {prisma,createTestCustomer} from "./helpers/factories";
import {importLegacyPrivateObject} from "@/lib/legacy-private-import";
import {barrier} from "./helpers/barrier";
let server:Server,scanner:ScannerServer,endpoint:string,scannerPort:string;
let publicBucket=false,encrypted=true,malware=false,putFailure=false,deleteFailure=false,puts=0;
let scannerUnavailable=false;
const scannerSockets=new Set<Socket>();
let putEntered:ReturnType<typeof barrier>|null=null,putRelease:ReturnType<typeof barrier>|null=null;
const objects=new Map<string,Buffer>(),deleted:string[]=[],kms="arn:aws:kms:us-east-1:000000000000:key/synthetic";
const sha=(key:string)=>createHash("sha256").update(key).digest("hex");
beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  const url=new URL(req.url!,endpoint||"http://localhost"),key=decodeURIComponent(url.pathname.slice("/synthetic/".length));
  res.setHeader("Content-Type","application/xml");
  if(url.searchParams.has("publicAccessBlock"))return res.end("<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>");
  if(url.searchParams.has("policyStatus"))return res.end(`<PolicyStatus><IsPublic>${publicBucket}</IsPublic></PolicyStatus>`);
  if(url.searchParams.has("encryption"))return res.end(`<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>${kms}</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`);
  if(url.searchParams.has("versions")){const prefix=url.searchParams.get("prefix")!;return res.end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${[...objects.keys()].filter(k=>k.startsWith(prefix)).map(k=>`<Version><Key>${k}</Key><VersionId>v1</VersionId></Version>`).join("")}</ListVersionsResult>`);}
  if(req.method==="PUT"){
   puts++;putEntered?.release();if(putRelease)await putRelease.wait;
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
   if(putFailure){res.statusCode=503;return res.end("<Error><Code>ServiceUnavailable</Code><Message>synthetic secret must not escape</Message></Error>");}
   if(objects.has(key)){res.statusCode=412;return res.end("<Error><Code>PreconditionFailed</Code></Error>");}
   expect(req.headers["if-none-match"]).toBe("*");expect(req.headers["x-amz-server-side-encryption"]).toBe("aws:kms");objects.set(key,Buffer.concat(chunks));res.statusCode=200;return res.end();
  }
  if(req.method==="DELETE"){if(deleteFailure){res.statusCode=503;return res.end("<Error><Code>ServiceUnavailable</Code></Error>");}expect(url.searchParams.get("versionId")).toBe("v1");deleted.push(key);objects.delete(key);res.statusCode=204;return res.end();}
  const bytes=objects.get(key);if(!bytes){res.statusCode=404;return res.end("<Error><Code>NoSuchKey</Code></Error>");}
  res.setHeader("Content-Type","application/octet-stream");res.setHeader("Content-Length",bytes.length);res.setHeader("x-amz-server-side-encryption",encrypted?"aws:kms":"AES256");res.setHeader("x-amz-server-side-encryption-aws-kms-key-id",kms);res.end(bytes);
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));endpoint="http://127.0.0.1:"+(server.address() as {port:number}).port;
 scanner=createScanner(socket=>{scannerSockets.add(socket);socket.on("close",()=>scannerSockets.delete(socket));if(scannerUnavailable){socket.end();return;}let input=Buffer.alloc(0);socket.on("data",chunk=>{input=Buffer.concat([input,chunk]);if(input.subarray(0,9).toString()==="zVERSION\0")return socket.end("ClamAV 1.4.2/12345/Synthetic\0");if(input.subarray(0,10).toString()!=="zINSTREAM\0")return;let position=10;while(position+4<=input.length){const size=input.readUInt32BE(position);position+=4;if(!size)return socket.end(malware?"stream: Synthetic.Test FOUND\0":"stream: OK\0");if(position+size>input.length)return;position+=size;}});});
 await new Promise<void>(resolve=>scanner.listen(0,"127.0.0.1",resolve));scannerPort=String((scanner.address() as {port:number}).port);
});
function configure(){for(const [key,value]of Object.entries({APP_ENV:"test",PRIVATE_STORAGE_PROVIDER:"s3",PRIVATE_STORAGE_REGION:"us-east-1",PRIVATE_STORAGE_ENDPOINT:endpoint,PRIVATE_STORAGE_BUCKET:"synthetic",PRIVATE_STORAGE_KMS_KEY_ID:kms,PRIVATE_STORAGE_ACCESS_KEY_ID:"synthetic",PRIVATE_STORAGE_SECRET_ACCESS_KEY:"synthetic",CLAMAV_HOST:"127.0.0.1",CLAMAV_PORT:scannerPort,CLAMAV_TLS:"false"}))vi.stubEnv(key,value);}
afterEach(()=>{publicBucket=false;encrypted=true;malware=false;scannerUnavailable=false;putFailure=false;deleteFailure=false;putEntered=null;putRelease?.release();putRelease=null;vi.unstubAllEnvs();});
afterAll(async()=>{server.closeAllConnections();for(const socket of scannerSockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>scanner.close(()=>resolve()));await prisma.$disconnect();});
it("uses the real AWS SDK against a controlled HTTP provider, rejects public buckets and incorrect encryption, and retries immutable object bytes",async()=>{
 configure();expect(await verifyPrivateBucket()).toBe(true);publicBucket=true;await expect(verifyPrivateBucket()).rejects.toThrow("UNSAFE");publicBucket=false;
 const key="s3:"+randomUUID()+".pdf",bytes=Buffer.from("synthetic private bytes");await putS3Private(key,bytes,"application/pdf");await putS3Private(key,bytes,"application/pdf");expect(await readS3Private(key)).toEqual(bytes);
 await expect(putS3Private(key,Buffer.from("changed"),"application/pdf")).rejects.toThrow("CONFLICT");encrypted=false;await expect(readS3Private(key)).rejects.toThrow("PRIVATE_READ_FAILED");encrypted=true;
 objects.set(key.slice(3)+"-unrelated",Buffer.from("keep"));await deleteS3Private(key);expect(objects.has(key.slice(3))).toBe(false);expect(objects.has(key.slice(3)+"-unrelated")).toBe(true);expect(deleted).toContain(key.slice(3));
 vi.stubEnv("APP_ENV","staging");await expect(readS3Private(key)).rejects.toThrow("TLS_REQUIRED");
});
it.each([false,true])("durably quarantines upload and records scanner version; infected=%s",async infected=>{
 configure();malware=infected;const stored=await storePrivateDocument(Buffer.from("synthetic scan fixture"),"application/pdf");
 await expect(readPrivateDocument(stored.storageKey)).rejects.toThrow("NOT_CLEAN");await prisma.operationsJob.update({where:{key:"scan:"+sha(stored.storageKey)},data:{nextAttemptAt:new Date(0)}});
 await runOperations("SCAN");const object=await prisma.privateObject.findUniqueOrThrow({where:{key:stored.storageKey}});expect(object).toMatchObject({state:infected?"INFECTED":"CLEAN",scanEngine:"ClamAV",scanVersion:"1.4.2/12345",writeState:"STORED"});
 if(infected)await expect(readPrivateDocument(stored.storageKey)).rejects.toThrow("NOT_CLEAN");else expect((await readPrivateDocument(stored.storageKey)).buffer.toString()).toBe("synthetic scan fixture");
});
it("preserves uncertain write intent, refuses another provider write, and never claims erasure after an uncertain upload",async()=>{
 configure();putFailure=true;const id=randomUUID(),key="s3:"+id+".pdf",before=puts;
 await expect(storePrivateDocument(Buffer.from("uncertain"),"application/pdf",id)).rejects.toThrow("REQUIRES_REVIEW");
 expect((await prisma.privateObject.findUniqueOrThrow({where:{key}})).writeState).toBe("UNCERTAIN");putFailure=false;
 await expect(storePrivateDocument(Buffer.from("uncertain"),"application/pdf",id)).rejects.toThrow("REQUIRES_REVIEW");expect(puts).toBe(before+1);
 await expect(deletePrivateDocument(key)).rejects.toThrow("REQUIRES_REVIEW");expect((await prisma.privateObject.findUniqueOrThrow({where:{key}})).state).toBe("DELETING");
});
it("serializes a real blocked provider upload with deletion and leaves no readable resurrected object",async()=>{
 configure();const id=randomUUID(),key="s3:"+id+".pdf";putEntered=barrier();putRelease=barrier();
 const upload=storePrivateDocument(Buffer.from("concurrent private fixture"),"application/pdf",id);await putEntered.wait;
 const removal=deletePrivateDocument(key);let waiting=false;
 try{for(let i=0;i<200;i++){const rows=await prisma.$queryRaw<Array<{count:bigint}>>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;if(Number(rows[0].count)>0){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);}finally{putRelease.release();}
 await Promise.all([upload,removal]);expect(objects.has(key.slice(3))).toBe(false);expect((await prisma.privateObject.findUniqueOrThrow({where:{key}})).state).toBe("DELETED");await expect(readPrivateDocument(key)).rejects.toThrow("NOT_CLEAN");
});
it("keeps failed provider deletions durable and resumes them through the real claimed worker",async()=>{
 configure();const stored=await storePrivateDocument(Buffer.from("delete recovery fixture"),"application/pdf");deleteFailure=true;await expect(deletePrivateDocument(stored.storageKey)).rejects.toThrow("PENDING");
 expect((await prisma.privateObject.findUniqueOrThrow({where:{key:stored.storageKey}})).state).toBe("DELETING");deleteFailure=false;await prisma.operationsJob.update({where:{key:"delete:"+sha(stored.storageKey)},data:{nextAttemptAt:new Date(0)}});await runOperations("DELETE");expect((await prisma.privateObject.findUniqueOrThrow({where:{key:stored.storageKey}})).state).toBe("DELETED");
});
it("fails closed on an unavailable scanner, exhausts bounded retries into review, then resumes the existing job",async()=>{
 configure();const stored=await storePrivateDocument(Buffer.from("scanner outage fixture"),"application/pdf"),key="scan:"+sha(stored.storageKey);scannerUnavailable=true;
 await prisma.operationsJob.update({where:{key},data:{nextAttemptAt:new Date(0),attempts:4}});
 await runOperations("SCAN");expect(await prisma.operationsJob.findUniqueOrThrow({where:{key}})).toMatchObject({state:"REVIEW",attempts:5,lastErrorCode:"SCAN_FAILED"});
 await expect(readPrivateDocument(stored.storageKey)).rejects.toThrow("NOT_CLEAN");
 // Explicit operator-boundary fixture: HTTP reauthentication is tested separately.
 scannerUnavailable=false;await prisma.operationsJob.update({where:{key},data:{state:"RETRY",attempts:0,nextAttemptAt:new Date(0)}});await runOperations("SCAN");
 expect((await prisma.operationsJob.findUniqueOrThrow({where:{key}})).state).toBe("DONE");expect((await readPrivateDocument(stored.storageKey)).buffer.toString()).toBe("scanner outage fixture");
});
it("imports only attached legacy bytes with matching evidence and fresh reauthentication, then releases quarantine through scanning",async()=>{
 configure();const admin=await createTestCustomer({role:"SUPER_ADMIN"}),owner=await createTestCustomer(),bytes=Buffer.from("synthetic legacy identity bytes"),key="s3:"+randomUUID()+".png";
 await putS3Private(key,bytes,"image/png");const document=await prisma.driverDocument.create({data:{userId:owner.id,type:"LICENSE_FRONT",storageKey:key,mimeType:"image/png",fileSizeBytes:bytes.length,contentSha256:sha(bytes.toString()),malwareScanStatus:"QUARANTINED"}});
 const input={action:"importLegacyObject",resourceType:"IDENTITY",resourceId:document.id,sha256:document.contentSha256,size:bytes.length,mimeType:"image/png",code:"123456",reason:"Controlled legacy import fixture with verified provider inventory"};
 await expect(importLegacyPrivateObject(admin.id,input)).rejects.toThrow("REAUTHENTICATION");
 const {hash:codeHash}=await import("bcryptjs");async function authorize(){await prisma.authCode.create({data:{email:admin.email,purpose:"SECURITY_STEP_UP",codeHash:await codeHash("123456",4),expiresAt:new Date(Date.now()+60000)}});}
 await authorize();await expect(importLegacyPrivateObject(admin.id,{...input,sha256:"0".repeat(64)})).rejects.toThrow("EVIDENCE_MISMATCH");expect(await prisma.privateObject.findUnique({where:{key}})).toBeNull();
 await authorize();expect(await importLegacyPrivateObject(admin.id,input)).toEqual({quarantined:true,held:true});
 expect((await prisma.privateObject.findUniqueOrThrow({where:{key}}))).toMatchObject({hold:true,state:"QUARANTINED",writeState:"STORED"});await expect(readPrivateDocument(key)).rejects.toThrow("NOT_CLEAN");
 await prisma.operationsJob.update({where:{key:"scan:"+sha(key)},data:{nextAttemptAt:new Date(0)}});await runOperations("SCAN");expect((await prisma.driverDocument.findUniqueOrThrow({where:{id:document.id}})).malwareScanStatus).toBe("CLEAN");expect((await readPrivateDocument(key)).buffer).toEqual(bytes);
 await expect(deletePrivateDocument(key)).rejects.toThrow("HELD");await authorize();await expect(importLegacyPrivateObject(admin.id,input)).rejects.toThrow("EXISTING_MANIFEST");
});
