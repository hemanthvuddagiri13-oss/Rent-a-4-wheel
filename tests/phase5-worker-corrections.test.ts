import {afterAll,afterEach,it,expect,vi} from "vitest";
import {PrismaClient} from "@prisma/client";
import {createHash,randomUUID} from "node:crypto";
import {prisma,createTestCustomer,createTestVehicle} from "./helpers/factories";
import {barrier} from "./helpers/barrier";
const io=vi.hoisted(()=>({read:vi.fn(),scan:vi.fn(),remove:vi.fn(),store:vi.fn()}));
vi.mock("@/lib/storage",()=>({readPrivateBytes:io.read,deletePrivateBytes:io.remove,storePrivateDocument:io.store}));
vi.mock("@/lib/clamav",()=>({scanWithClamAv:io.scan,scannerVersion:async()=>"controlled-scanner"}));
import {claimOperations,finishOperation,runOperations} from "@/lib/operations";
import {POST as cron} from "@/app/api/cron/operations/[worker]/route";
import * as operations from "@/lib/operations";
import {monitorOperations} from "@/lib/observability";
const other=new PrismaClient();
const deferred=new Map<string,Date>();
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();for(const f of Object.values(io))f.mockReset();for(const [key,nextAttemptAt]of deferred)await prisma.operationsJob.update({where:{key},data:{nextAttemptAt}});deferred.clear();});
afterAll(async()=>{await other.$disconnect();await prisma.$disconnect();});

it("finishes against database time even when application clock is one day ahead",async()=>{
 const kind="CLOCK_"+randomUUID(),key=randomUUID();await prisma.operationsJob.create({data:{key,kind}});
 const [job]=await claimOperations(kind);
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()+86400000));
 expect((await finishOperation(job,"DONE")).count).toBe(1);
});
it("claims and finishes UTC timestamp columns even on a non-UTC PostgreSQL session",async()=>{
 await other.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Chicago'");
  const kind="TZ_"+randomUUID();await tx.operationsJob.create({data:{key:randomUUID(),kind,nextAttemptAt:new Date()}});
  const jobs=await claimOperations(kind,tx as PrismaClient);expect(jobs).toHaveLength(1);
  expect((await finishOperation(jobs[0],"DONE",undefined,tx)).count).toBe(1);
 });
});

async function isolate(kind:string){
 // Only the disposable test database is used; keep unrelated retained fixtures
 // out of this bounded worker batch without deleting their evidence.
 if(!(await prisma.$queryRaw<Array<{name:string}>>`SELECT current_database() name`)[0].name.endsWith("_test"))throw new Error("Isolated test database required");
 for(const row of await prisma.operationsJob.findMany({where:{kind,state:{in:["PENDING","RETRY","RUNNING"]}}})){if(!deferred.has(row.key))deferred.set(row.key,row.nextAttemptAt);await prisma.operationsJob.update({where:{key:row.key},data:{nextAttemptAt:new Date("2099-01-01")}});}
}
async function scanJob(isolated=false){
 if(!isolated)await isolate("SCAN");
 const key="s3:worker-correction-"+randomUUID(),bytes=Buffer.from("Controlled private object");
 await prisma.privateObject.create({data:{key,sha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.length,mimeType:"image/png",state:"QUARANTINED",writeState:"STORED"}});
 const job=await prisma.operationsJob.create({data:{key:randomUUID(),kind:"SCAN",resourceId:key}});
 return {job,key,bytes};
}

it("reports a stale scan as stale after separate-connection takeover and commits no stale projection",async()=>{
 const f=await scanJob(),entered=barrier(),release=barrier();io.scan.mockResolvedValue({status:"CLEAN"});
 io.read.mockImplementationOnce(async()=>{entered.release();await release.wait;return f.bytes;});
 const stale=runOperations("SCAN");await entered.wait;
 await other.$executeRaw`UPDATE "OperationsJob" SET "leaseExpiresAt"=CURRENT_TIMESTAMP-interval '1 second' WHERE key=${f.job.key}`;
 const [successor]=await claimOperations("SCAN",other);expect(successor.leaseToken).not.toBeNull();
 release.release();const result=await stale;
 expect(result).toMatchObject({completed:0,stale:1,failed:0});
 expect(await prisma.privateObject.findUniqueOrThrow({where:{key:f.key}})).toMatchObject({state:"SCANNING",scanEngine:null});
 expect((await finishOperation(successor,"DONE",undefined,other)).count).toBe(1);
});

it("reports mixed scan completion, quarantine and exhausted review using database time",async()=>{
 await isolate("SCAN");const good=await scanJob(true),bad=await scanJob(true);
 io.read.mockImplementation(async(key:string)=>{if(key===bad.key)throw new Error("Controlled read failure");return good.bytes;});io.scan.mockResolvedValue({status:"INFECTED"});
 const exhausted=await prisma.operationsJob.create({data:{key:randomUUID(),kind:"SCAN",resourceId:bad.key,state:"RUNNING",attempts:5,leaseToken:randomUUID(),leaseExpiresAt:new Date(0)}});
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2000-01-01"));
 expect(await runOperations("SCAN")).toMatchObject({claimed:2,processed:2,completed:1,failed:1,quarantined:2,review:1,stale:0});
 expect(await prisma.operationsJob.findUniqueOrThrow({where:{key:exhausted.key}})).toMatchObject({state:"REVIEW",lastErrorCode:"LEASE_EXHAUSTED"});
});

it.each(["DELETE","AGREEMENT"] as const)("fences stale %s projection after takeover and resumes the same provider identity",async kind=>{
 await isolate(kind);const entered=barrier(),release=barrier();let resourceId:string;
 if(kind==="DELETE"){
  resourceId="s3:delete-"+randomUUID();await prisma.privateObject.create({data:{key:resourceId,sha256:"a".repeat(64),size:1,mimeType:"image/png",state:"DELETING",writeState:"STORED"}});
  io.remove.mockImplementationOnce(async()=>{entered.release();await release.wait;});io.remove.mockResolvedValue(undefined);
 }else{
  const user=await createTestCustomer(),vehicle=await createTestVehicle();
  resourceId=(await prisma.agreementAcceptance.create({data:{type:"HOST_AGREEMENT",vehicleId:vehicle.id,signedByUserId:user.id,signerName:"Fixture Signer",documentVersion:"1",contentSnapshot:"Synthetic retained terms",contentHash:"a".repeat(64),subjectSnapshot:{vehicle:{id:vehicle.id}}}})).id;
  io.store.mockImplementationOnce(async(_bytes:Buffer,_mime:string,id:string)=>{entered.release();await release.wait;return{storageKey:"s3:"+id+".pdf"};});io.store.mockImplementation(async(_bytes:Buffer,_mime:string,id:string)=>({storageKey:"s3:"+id+".pdf"}));
 }
 const job=await prisma.operationsJob.create({data:{key:randomUUID(),kind,resourceId}});
 const stale=runOperations(kind);await entered.wait;
 await other.$executeRaw`UPDATE "OperationsJob" SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE key=${job.key}`;
 const [successor]=await claimOperations(kind,other);expect(successor.key).toBe(job.key);
 release.release();expect(await stale).toMatchObject({completed:0,stale:1,failed:0});
 if(kind==="DELETE")expect((await prisma.privateObject.findUniqueOrThrow({where:{key:resourceId}})).state).toBe("DELETING");
 else expect((await prisma.agreementAcceptance.findUniqueOrThrow({where:{id:resourceId}})).signedPdfStorageKey).toBeNull();
 await other.$executeRaw`UPDATE "OperationsJob" SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE key=${job.key}`;
 expect(await runOperations(kind)).toMatchObject({completed:1,stale:0,failed:0});
 if(kind==="DELETE"){expect(io.remove).toHaveBeenCalledTimes(2);expect(io.remove.mock.calls.every(([key])=>key===resourceId)).toBe(true);}
 else{expect(io.store).toHaveBeenCalledTimes(2);expect(io.store.mock.calls[0]).toEqual(io.store.mock.calls[1]);expect(await prisma.agreementArtifact.count({where:{acceptanceId:resourceId}})).toBe(1);}
});

it("fences an alert response after a separate connection takes its lease",async()=>{
 await isolate("ALERT");
 vi.spyOn(operations,"operationalMetrics").mockResolvedValue({uncertain:0,refunds:0,deposits:0,payoutHolds:0,outbox:0,scanFailures:0,deletionFailures:0,overdueCases:0,uncertainWrites:0,staleWorkers:0,agreementFailures:0,retentionFailures:0,operatorReviews:0});
 vi.stubEnv("MONITORING_ALERT_URL","https://controlled.invalid");vi.stubEnv("MONITORING_ALERT_SECRET","controlled-secret");
 const entered=barrier(),release=barrier(),job=await prisma.operationsJob.create({data:{key:randomUUID(),kind:"ALERT",payload:{event:"RECOVERY_BACKLOG"}}});
 const provider=vi.spyOn(globalThis,"fetch").mockImplementationOnce(async()=>{entered.release();await release.wait;return new Response(null,{status:200});}).mockResolvedValue(new Response(null,{status:200}));
 const stale=monitorOperations();await entered.wait;
 await other.$executeRaw`UPDATE "OperationsJob" SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE key=${job.key}`;
 expect((await claimOperations("ALERT",other))[0].key).toBe(job.key);release.release();
 expect(await stale).toMatchObject({completed:0,delivered:0,stale:1});
 await other.$executeRaw`UPDATE "OperationsJob" SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE key=${job.key}`;
 expect(await monitorOperations()).toMatchObject({completed:1,delivered:1,stale:0});
 expect(provider).toHaveBeenCalledTimes(2);expect(provider.mock.calls[0][1]?.body).toEqual(provider.mock.calls[1][1]?.body);expect(provider.mock.calls[0][1]?.headers).toEqual(provider.mock.calls[1][1]?.headers);
});

it("authenticated cron exposes an entirely failed scan batch as failed to monitoring",async()=>{
 await scanJob();io.read.mockRejectedValue(new Error("Controlled provider failure"));vi.stubEnv("CRON_SECRET","x".repeat(40));
 const response=await cron(new Request("https://fixture.invalid/api/cron/operations/scan",{method:"POST",headers:{authorization:"Bearer "+"x".repeat(40)}}),{params:Promise.resolve({worker:"scan"})});
 expect(response.status).toBe(503);
 expect(await response.json()).toMatchObject({claimed:1,processed:1,completed:0,failed:1,stale:0,review:0});
 expect(await prisma.operationalEvent.findFirst({where:{source:"operations/scan"},orderBy:{createdAt:"desc"}})).toMatchObject({category:"CRON_FAILED"});
});
