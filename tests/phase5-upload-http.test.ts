import {beforeAll,afterAll,it,expect} from "vitest";
import {spawn,type ChildProcess} from "node:child_process";
import {createServer,type Server} from "node:http";
import {createServer as tcpServer,type Server as TcpServer} from "node:net";
import {randomBytes} from "node:crypto";
import sharp from "sharp";
import {encode} from "next-auth/jwt";
import {createDeviceSession} from "@/lib/device-sessions";
import {createTestCustomer,createTestHost,createTestVehicle,createTestReservation,prisma} from "./helpers/factories";
import {openConversation} from "@/lib/conversations";
const base="http://127.0.0.1:3216",secret=randomBytes(48).toString("hex");
let child:ChildProcess,storage:Server,scanner:TcpServer,cookie:string,conversationId:string,caseId:string;
let providerCalls=0,scanCalls=0;const kms="synthetic-private-key";
beforeAll(async()=>{
 storage=createServer(async(req,res)=>{
  providerCalls++;const url=new URL(req.url!,"http://localhost");res.setHeader("Content-Type","application/xml");
  if(url.searchParams.has("publicAccessBlock"))return res.end("<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>");
  if(url.searchParams.has("policyStatus"))return res.end("<PolicyStatus><IsPublic>false</IsPublic></PolicyStatus>");
  if(url.searchParams.has("encryption"))return res.end(`<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>${kms}</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`);
  if(req.method==="PUT"){for await(const chunk of req)void chunk;res.statusCode=200;return res.end();}res.statusCode=404;res.end();
 });
 await new Promise<void>(resolve=>storage.listen(0,"127.0.0.1",resolve));
 scanner=tcpServer(socket=>{scanCalls++;let bytes=Buffer.alloc(0);socket.on("data",chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.subarray(0,10).toString()!=="zINSTREAM\0")return;let p=10;while(p+4<=bytes.length){const n=bytes.readUInt32BE(p);p+=4;if(!n)return socket.end("stream: OK\0");if(p+n>bytes.length)return;p+=n;}});});
 await new Promise<void>(resolve=>scanner.listen(0,"127.0.0.1",resolve));
 const customer=await createTestCustomer(),host=await createTestHost(),vehicle=await createTestVehicle({hostId:host.hostProfile.id,listingApproval:"APPROVED"});
 const r=await createTestReservation({customerId:customer.id,vehicleId:vehicle.id,pickupAt:new Date("2048-01-01"),returnAt:new Date("2048-01-04"),status:"ACTIVE"});
 conversationId=(await openConversation(customer.id,{reservationId:r.id})).id;
 caseId=(await prisma.serviceCase.create({data:{kind:"CLAIM",reservationId:r.id,vehicleId:vehicle.id,openedById:customer.id,category:"DAMAGE",title:"Synthetic attachment claim",details:{summary:"Controlled fixture"},dueAt:new Date("2048-01-05"),retainUntil:new Date("2050-01-01")}})).id;
 const s=await createDeviceSession(customer.id),salt="authjs.session-token";
 cookie=salt+"="+await encode({secret,salt,token:{id:customer.id,sub:customer.id,role:"CUSTOMER",sid:s.sid,rotation:s.rotation},maxAge:3600});
 child=spawn(process.execPath,["tests/helpers/built-http-server.mjs"],{stdio:"inherit",env:{...process.env,APP_ENV:"test",NODE_ENV:"development",VERCEL_ENV:"",BROWSER_TEST_PORT:"",BUILT_HTTP_TEST_PORT:"3216",SITE_URL:base,AUTH_URL:base,NEXTAUTH_URL:base,AUTH_SECRET:secret,AUTH_TRUST_HOST:"true",PRIVATE_STORAGE_PROVIDER:"s3",PRIVATE_STORAGE_ENDPOINT:"http://127.0.0.1:"+(storage.address() as {port:number}).port,PRIVATE_STORAGE_BUCKET:"synthetic",PRIVATE_STORAGE_REGION:"us-east-1",PRIVATE_STORAGE_KMS_KEY_ID:kms,PRIVATE_STORAGE_ACCESS_KEY_ID:"synthetic",PRIVATE_STORAGE_SECRET_ACCESS_KEY:"synthetic",CLAMAV_HOST:"127.0.0.1",CLAMAV_PORT:String((scanner.address() as {port:number}).port),CLAMAV_TLS:"false",STRIPE_SECRET_KEY:"",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"",STRIPE_WEBHOOK_SECRET:""}});
 let ready=false;for(let n=0;n<120;n++){if(child.exitCode!==null)break;try{const response=await fetch(base+"/api/auth/session",{headers:{cookie}});if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}expect(ready).toBe(true);
},60000);
afterAll(async()=>{if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>setTimeout(resolve,300));}storage?.closeAllConnections();if(storage)await new Promise<void>(r=>storage.close(()=>r()));if(scanner)await new Promise<void>(r=>scanner.close(()=>r()));await prisma.$disconnect();});
async function upload(bytes:Buffer,claim=false){const form=new FormData();form.set(claim?"caseId":"conversationId",claim?caseId:conversationId);form.set("purpose",claim?"DAMAGE":"MESSAGE");form.set("file",new Blob([new Uint8Array(bytes)],{type:"image/png"}),"fixture.png");return fetch(base+"/api/community",{method:"POST",headers:{origin:base,cookie},body:form});}
function padPng(bytes:Buffer,size:number){
 const data=Buffer.alloc(size-bytes.length-12,65);Buffer.from("Comment\0").copy(data);
 const type=Buffer.from("tEXt"),body=Buffer.concat([type,data]);let crc=0xffffffff;
 for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);
 return Buffer.concat([bytes.subarray(0,-12),length,body,sum,bytes.subarray(-12)]);
}
it("built proxy accepts a valid attachment larger than 24 KB",async()=>{
 const bytes=await sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer();expect(bytes.length).toBeGreaterThan(24000);
 const response=await upload(bytes);expect(response.status,await response.text()).toBe(200);
});
it("accepts a claim attachment through the built proxy and refuses malformed bytes before provider calls",async()=>{
 const bytes=await sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer();
 const response=await upload(bytes,true);expect(response.status,await response.text()).toBe(200);
 const calls=[providerCalls,scanCalls],before=await prisma.collaborationFile.count({where:{caseId}});
 const invalid=await upload(Buffer.from("malformed image fixture"),true);expect(invalid.status).toBe(409);
 expect([providerCalls,scanCalls]).toEqual(calls);expect(await prisma.collaborationFile.count({where:{caseId}})).toBe(before);
});
it("accepts the documented 8 MB file maximum and rejects larger files before any provider call",async()=>{
 const image=await sharp(randomBytes(1536*1536*3),{raw:{width:1536,height:1536,channels:3}}).png().toBuffer();const maximum=padPng(image,8*1024*1024);
 const valid=await upload(maximum);expect(valid.status,await valid.text()).toBe(200);
 const calls=[providerCalls,scanCalls],before=await prisma.collaborationFile.count();
 const invalid=await upload(Buffer.concat([maximum,Buffer.from([0])]));expect(invalid.status).toBe(413);
 expect([providerCalls,scanCalls]).toEqual(calls);expect(await prisma.collaborationFile.count()).toBe(before);
 const tooLarge=await upload(Buffer.alloc(10*1024*1024));expect(tooLarge.status).toBe(413);expect([providerCalls,scanCalls]).toEqual(calls);
});
it("keeps JSON requests at the smaller limit",async()=>{
 const calls=[providerCalls,scanCalls];const response=await fetch(base+"/api/community",{method:"POST",headers:{origin:base,cookie,"content-type":"application/json"},body:JSON.stringify({action:"conversation",padding:"x".repeat(24000)})});
 expect(response.status).toBe(413);expect([providerCalls,scanCalls]).toEqual(calls);
});
