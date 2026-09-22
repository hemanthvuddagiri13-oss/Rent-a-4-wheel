import {it,expect,vi,afterEach,afterAll} from "vitest";
import {failedWorkerBatch,observeWorker} from "@/lib/observability";
import {workerResult,summarizeWorker,workerHttpStatus} from "@/lib/worker-result";
import {prisma,createTestCustomer} from "./helpers/factories";
import {deliverNoticeChannels} from "@/lib/notice-channels";
import {POST} from "@/app/api/cron/community/route";
import {dispatchCron} from "../scripts/dispatch-cron.mjs";
import {financialWorkers} from "@/lib/financial-workers";
import {recordRelease} from "@/lib/release-outcomes";
import {POST as financialCron} from "@/app/api/cron/financial/[worker]/route";
import {NextRequest} from "next/server";
import {prisma as workerDb} from "@/lib/prisma";
const users:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();await prisma.channelDelivery.deleteMany({where:{userId:{in:users}}});await prisma.inboxNotice.deleteMany({where:{userId:{in:users}}});users.length=0;});afterAll(()=>prisma.$disconnect());
it("counts nested deposit releases once and preserves committed work alongside failures",()=>{
 const result=summarizeWorker({processed:2,pending:3,failed:2,uncertain:1,deposits:{processed:1,pending:1},releases:{processed:1,failed:1,quarantined:0,uncertain:1}});
 expect(result).toMatchObject({committed:2,failed:2,uncertain:1,status:"PARTIAL_FAILURE"});
 expect(summarizeWorker({processed:1,failed:2})).toMatchObject({committed:1,failed:2,status:"PARTIAL_FAILURE"});
});
it("financial cron observes deduplicated all-quarantined release outcomes before returning HTTP status",async()=>{
 vi.stubEnv("CRON_SECRET","fixture-cron");
 vi.spyOn(financialWorkers,"refunds").mockImplementation(async()=>{recordRelease({operationId:"fixture-release",status:"quarantined"});recordRelease({operationId:"fixture-release",status:"quarantined"});return {processed:0,pending:0};});
 const response=await financialCron(new NextRequest("http://localhost/api/cron/financial/refunds",{method:"POST",headers:{authorization:"Bearer fixture-cron"}}),{params:Promise.resolve({worker:"refunds"})});
 expect(response.status).toBe(503);expect((await response.json()).worker).toMatchObject({status:"FAILED",committed:0,quarantined:1});
 expect((await prisma.operationalEvent.findFirstOrThrow({where:{source:"financial/refunds"},orderBy:{createdAt:"desc"}})).category).toBe("CRON_FAILED");
});
it("does not hide an all-review nested channel batch",()=>{
 expect(failedWorkerBatch({notifications:{processed:0},retention:{processed:0},channels:{accepted:0,review:3}})).toBe(true);
});
it.each([{committed:0,review:3},{committed:0,failed:3},{committed:1,failed:2},{committed:1,uncertain:1}])("classifies nested outcomes %j explicitly",async counts=>{
 const result=summarizeWorker({notifications:workerResult(),retention:workerResult(),channels:workerResult(counts)});
 expect(result.status).toBe(counts.committed?"PARTIAL_FAILURE":"FAILED");expect(workerHttpStatus(result)).toBe(503);
 const observed=await observeWorker("community",async()=>({channels:workerResult(counts)}));expect(observed.worker.status).toBe(result.status);
 const event=await prisma.operationalEvent.findFirstOrThrow({where:{source:"community"},orderBy:{createdAt:"desc"}});expect(event.category).toBe(counts.committed?"CRON_PARTIAL_FAILURE":"CRON_FAILED");
});
it.each(["SUCCESS","PARTIAL_FAILURE","FAILED","DISABLED","NO_WORK"] as const)("dispatcher interprets %s even with HTTP 200",async status=>{
 const request:typeof fetch=async()=>Response.json({worker:{status}}),env:NodeJS.ProcessEnv={NODE_ENV:"test",SITE_URL:"https://fixture.invalid",CRON_SECRET:"a".repeat(40)};
 if(["FAILED","PARTIAL_FAILURE"].includes(status))await expect(dispatchCron("community",env,request)).rejects.toThrow("CRON_WORKER_"+status);else await expect(dispatchCron("community",env,request)).resolves.toMatchObject({status:200});
});
async function sms(){const u=await createTestCustomer();users.push(u.id);await prisma.smsConsent.create({data:{userId:u.id,phone:"+15551234567",source:"HANDSET_CONFIRMED",consentAt:new Date()}});const n=await prisma.inboxNotice.create({data:{userId:u.id,eventKey:crypto.randomUUID(),category:"MESSAGE",title:"Private fixture",resourceType:"RESERVATION",resourceId:crypto.randomUUID()}});await prisma.noticePreference.create({data:{userId:u.id,category:"MESSAGE",sms:true,email:false}});return n;}
it("retains a committed delivery when a later database claim fails",async()=>{
 vi.stubEnv("APP_ENV","test");vi.stubEnv("TWILIO_ACCOUNT_SID","AC_fixture");vi.stubEnv("TWILIO_AUTH_TOKEN","fixture");vi.stubEnv("TWILIO_FROM_NUMBER","+15550000001");
 await sms();await sms();const send=vi.fn(async()=>Response.json({sid:"SM_"+crypto.randomUUID(),status:"accepted"}));vi.stubGlobal("fetch",send);
 const transaction=workerDb.$transaction.bind(workerDb);let transactions=0;
 const spy=vi.spyOn(workerDb,"$transaction").mockImplementation(((...args:Parameters<typeof transaction>)=>{if(++transactions===3)return Promise.reject(new Error("Controlled next-claim failure"));return transaction(...args);}) as typeof workerDb.$transaction);
 const result=await deliverNoticeChannels();spy.mockRestore();expect(result).toMatchObject({committed:1,accepted:1,failed:1,status:"PARTIAL_FAILURE"});expect(send).toHaveBeenCalledTimes(1);
 expect(await prisma.channelDelivery.count({where:{userId:{in:users},state:"ACCEPTED"}})).toBe(1);
 await deliverNoticeChannels();expect(send).toHaveBeenCalledTimes(2);await deliverNoticeChannels();expect(send).toHaveBeenCalledTimes(2);
});
it.each(["review","failed","mixed","uncertain"] as const)("real channel delivery reports %s and does not resend uncertain work",async outcome=>{
 vi.stubEnv("APP_ENV","test");vi.stubEnv("TWILIO_ACCOUNT_SID","AC_fixture");vi.stubEnv("TWILIO_AUTH_TOKEN","fixture");vi.stubEnv("TWILIO_FROM_NUMBER","+15550000001");
 const count=outcome==="mixed"?3:outcome==="uncertain"?2:1;for(let i=0;i<count;i++)await sms();let calls=0;
 const send=vi.fn(async()=>{const index=calls++;if((outcome==="mixed"||outcome==="uncertain")&&index===0)return Response.json({sid:"SM_"+crypto.randomUUID(),status:"accepted"});if(outcome==="uncertain")throw new Error("Provider response lost");return Response.json({message:"controlled failure"},{status:outcome==="review"?503:400});});vi.stubGlobal("fetch",send);
 const result=await deliverNoticeChannels();expect(result.attempted).toBe(count);expect(result.accepted).toBe(outcome==="mixed"||outcome==="uncertain"?1:0);expect(result.failed).toBe(outcome==="mixed"?2:outcome==="failed"?1:0);expect(result.uncertain).toBe(outcome==="review"||outcome==="uncertain"?1:0);expect(result.status).toBe(result.accepted?"PARTIAL_FAILURE":"FAILED");
 await deliverNoticeChannels();expect(send).toHaveBeenCalledTimes(count);
});
it("disabled provider does not attempt sends and authenticated cron exposes actionable nested results",async()=>{
 vi.stubEnv("APP_ENV","test");vi.stubEnv("TWILIO_ACCOUNT_SID","");vi.stubEnv("TWILIO_AUTH_TOKEN","");vi.stubEnv("CRON_SECRET","fixture-cron");
 const send=vi.fn();vi.stubGlobal("fetch",send);await sms();const channel=await deliverNoticeChannels();expect(channel).toMatchObject({attempted:0,committed:0,configured:false,disabled:1});expect(send).not.toHaveBeenCalled();
 const n=await sms();await prisma.channelDelivery.create({data:{noticeId:n.id,userId:n.userId,channel:"SMS",state:"DISPATCHING",leaseToken:"expired",leaseUntil:new Date(0)}});
 expect((await POST(new Request("http://localhost/api/cron/community"))).status).toBe(401);
 const response=await POST(new Request("http://localhost/api/cron/community",{method:"POST",headers:{authorization:"Bearer fixture-cron"}}));expect(response.status).toBe(503);const body=await response.json();expect(body.worker.status).toMatch(/FAILED|PARTIAL_FAILURE/);expect(body.worker.children.channels.review).toBeGreaterThanOrEqual(1);expect(body.worker.children).toHaveProperty("notifications");expect(body.worker.children).toHaveProperty("retention");expect(send).not.toHaveBeenCalled();
});
