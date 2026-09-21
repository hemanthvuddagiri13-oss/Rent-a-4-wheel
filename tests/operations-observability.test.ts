import {afterAll,afterEach,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {monitorOperations} from "@/lib/observability";
import {claimOperations} from "@/lib/operations";
import {WORKER_STALENESS_MINUTES,staleWorkerCount} from "@/lib/worker-schedule";
import {prisma} from "./helpers/factories";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();});afterAll(()=>prisma.$disconnect());
it("detects silent or stale schedules using persisted successful worker observations",async()=>{
 await prisma.operationalEvent.createMany({data:Object.keys(WORKER_STALENESS_MINUTES).map(source=>({category:"CRON_COMPLETE",severity:"INFO",source}))});expect(await staleWorkerCount()).toBe(0);
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.now()+2*60*60000);expect(await staleWorkerCount()).toBe(Object.keys(WORKER_STALENESS_MINUTES).length);
});
it("replays the exact persisted alert payload and key after an uncertain provider response",async()=>{
 vi.stubEnv("MONITORING_ALERT_URL","https://controlled-provider.invalid/alerts");vi.stubEnv("MONITORING_ALERT_SECRET","synthetic-alert-secret");
 const requests:Array<{key:string;body:string}>=[];let reject=true;
 // Explicit provider boundary fixture: persisted intent, real DB claim and retry are unchanged.
 vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{requests.push({key:(init.headers as Record<string,string>)["Idempotency-Key"],body:String(init.body)});if(reject)throw new Error("Synthetic response lost after provider acceptance");return new Response(null,{status:202});}));
 // A backlog guarantees alert creation without modifying financial records.
 const key="fixture-alert-backlog:"+randomUUID();await prisma.operationsJob.create({data:{key,kind:"SCAN",state:"REVIEW"}});
 await monitorOperations();expect(requests.length).toBeGreaterThan(0);const first=requests.at(-1)!;const job=await prisma.operationsJob.findUniqueOrThrow({where:{key:first.key}});expect(job.state).toBe("RETRY");expect(JSON.stringify(job.payload)).toBe(first.body);
 await expect(prisma.operationsJob.update({where:{key:first.key},data:{payload:{changed:true}}})).rejects.toThrow("immutable");
 reject=false;await prisma.operationsJob.update({where:{key:first.key},data:{nextAttemptAt:new Date(0)}});await prisma.operationsJob.update({where:{key},data:{state:"DONE"}});await monitorOperations();
 const replays=requests.filter(r=>r.key===first.key);expect(replays.length).toBeGreaterThanOrEqual(2);expect(new Set(replays.map(r=>r.body)).size).toBe(1);expect((await prisma.operationsJob.findUniqueOrThrow({where:{key:first.key}})).state).toBe("DONE");
});
it("moves a worker that crashes on its last lease into review instead of leaving it permanently running",async()=>{
 const kind="EXHAUSTED_"+randomUUID(),key=kind;await prisma.operationsJob.create({data:{key,kind,state:"RUNNING",attempts:5,leaseToken:randomUUID(),leaseExpiresAt:new Date(0)}});
 expect(await claimOperations(kind)).toEqual([]);expect(await prisma.operationsJob.findUniqueOrThrow({where:{key}})).toMatchObject({state:"REVIEW",lastErrorCode:"LEASE_EXHAUSTED",leaseToken:null});
});
