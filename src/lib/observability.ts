import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { safeLog } from "@/lib/safe-log";
import { operationalMetrics,claimOperationsBatch,finishOperation } from "@/lib/operations";
import {summarizeWorker,workerHttpStatus} from "@/lib/worker-result";
const categories=new Set(["AUTH_DENIED","AUTHORIZATION_DENIED","WEBHOOK_FAILED","STORAGE_FAILED","CRON_FAILED","CRON_PARTIAL_FAILURE","CRON_IDLE","CRON_COMPLETE","APPLICATION_FAILED","BACKLOG_ALERT"]);
export async function recordOperationalEvent(category:string,severity:"INFO"|"WARNING"|"CRITICAL",requestId?:string,count=1,source?:string,durationMs?:number){
 if(!categories.has(category))throw new Error("UNKNOWN_OBSERVABILITY_EVENT");
 const id=requestId&&/^[a-f0-9-]{36}$/.test(requestId)?requestId:randomUUID();
 await prisma.operationalEvent.create({data:{category,severity,requestId:id,source:source&&/^[a-z/-]{1,60}$/.test(source)?source:undefined,durationMs,count:Number.isSafeInteger(count)&&count>0?Math.min(count,1000000):1}});
 console.info(JSON.stringify({event:category,severity,requestId:id}));
}
export async function reportOperationalEvent(category:string,severity:"INFO"|"WARNING"|"CRITICAL",requestId?:string){
 try{await recordOperationalEvent(category,severity,requestId);}catch{safeLog("OBSERVABILITY_UNAVAILABLE");}
}
export function failedWorkerBatch(value:unknown){return workerHttpStatus(summarizeWorker(value))!==200;}
export async function observeWorker<T>(name:string,run:()=>Promise<T>){const start=Date.now();try{const result=await run(),worker=summarizeWorker(result);const category=worker.status==="FAILED"?"CRON_FAILED":worker.status==="PARTIAL_FAILURE"?"CRON_PARTIAL_FAILURE":["DISABLED","NO_WORK"].includes(worker.status)?"CRON_IDLE":"CRON_COMPLETE";await recordOperationalEvent(category,worker.status==="FAILED"?"CRITICAL":worker.status==="PARTIAL_FAILURE"?"WARNING":"INFO",undefined,Math.max(1,worker.failed+worker.review+worker.uncertain+worker.stale),name,Math.max(1,Date.now()-start));return {...result,worker};}catch(error){safeLog("CRON_FAILED",error);await recordOperationalEvent("CRON_FAILED","CRITICAL",undefined,1,name,Math.max(1,Date.now()-start));throw new Error("WORKER_RETRY_REQUIRED");}}
export async function monitorOperations(){
 const metrics=await operationalMetrics(),total=Object.values(metrics).reduce((a,b)=>a+b,0);
 if(total){await recordOperationalEvent("BACKLOG_ALERT","CRITICAL",undefined,total);const key="alert:"+Math.floor(Date.now()/300000);await prisma.operationsJob.upsert({where:{key},create:{key,kind:"ALERT",payload:{event:"RECOVERY_BACKLOG",severity:"CRITICAL",metrics}},update:{}});}
 const batch=await claimOperationsBatch("ALERT"),jobs=batch.jobs;let delivered=0,failed=0,stale=0,review=batch.review;
 for(const job of jobs)try{if(!job.payload)throw new Error("ALERT_PAYLOAD_MISSING");const target=process.env.MONITORING_ALERT_URL,secret=process.env.MONITORING_ALERT_SECRET;if(!target?.startsWith("https://")||!secret)throw new Error("ALERT_NOT_CONFIGURED");const response=await fetch(target,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${secret}`,"Idempotency-Key":job.key},body:JSON.stringify(job.payload),redirect:"error",signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error("ALERT_NOT_ACCEPTED");if((await finishOperation(job,"DONE")).count)delivered++;else stale++;}catch{if((await finishOperation(job,job.attempts>=5?"REVIEW":"RETRY","ALERT_FAILED")).count){failed++;if(job.attempts>=5)review++;}else stale++;}
 return {metrics,claimed:jobs.length,processed:delivered+failed,completed:delivered,delivered,failed,quarantined:0,review,stale};
}
