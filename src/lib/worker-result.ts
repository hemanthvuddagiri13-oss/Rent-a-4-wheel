export type WorkerStatus="SUCCESS"|"PARTIAL_FAILURE"|"FAILED"|"DISABLED"|"NO_WORK";
export type WorkerCounts={attempted:number;committed:number;processed:number;failed:number;stale:number;review:number;quarantined:number;uncertain:number;skipped:number;disabled:number};
export type WorkerResult=WorkerCounts&{status:WorkerStatus;children?:Record<string,WorkerResult>};
export function workerResult(input:Partial<WorkerCounts>={},children?:Record<string,WorkerResult>):WorkerResult{
 const counts:WorkerCounts={attempted:0,committed:0,processed:0,failed:0,stale:0,review:0,quarantined:0,uncertain:0,skipped:0,disabled:0};
 for(const k of Object.keys(counts) as Array<keyof WorkerCounts>)if(input[k]!==undefined)counts[k]=input[k]!;
 if(children)for(const child of Object.values(children))for(const k of Object.keys(counts) as Array<keyof WorkerCounts>)counts[k]+=child[k];
 for(const n of Object.values(counts))if(!Number.isSafeInteger(n)||n<0)throw new Error("INVALID_WORKER_COUNTS");
 counts.processed=counts.committed;
 const bad=counts.failed+counts.stale+counts.review+counts.quarantined+counts.uncertain;
 const status:WorkerStatus=bad?(counts.committed?"PARTIAL_FAILURE":"FAILED"):counts.committed?"SUCCESS":counts.disabled?"DISABLED":"NO_WORK";
 return {...counts,status,...(children?{children}:{})};
}
/** Explicit adapters for existing worker APIs; metrics are never counted as work. */
export function summarizeWorker(value:unknown):WorkerResult{
 if(!value||typeof value!=="object")return workerResult();
 const r=value as Record<string,unknown>;
 if(r.worker)return summarizeWorker(r.worker);
 if(typeof r.status==="string"&&typeof r.committed==="number")return workerResult(r as WorkerResult);
 const children:Record<string,WorkerResult>={};
 for(const key of ["notifications","retention","channels"])if(r[key])children[key]=summarizeWorker(r[key]);
 if(Object.keys(children).length)return workerResult({},children);
 const n=(key:string)=>typeof r[key]==="number"?r[key] as number:0;
 const failed=n("failed")+n("pending"),committed=typeof r.completed==="number"?n("completed"):typeof r.delivered==="number"?n("delivered"):typeof r.accepted==="number"?n("accepted"):Math.max(0,n("processed")-n("failed"));
 return workerResult({attempted:n("attempted"),committed,failed,stale:n("stale"),review:n("review"),quarantined:n("quarantined"),uncertain:n("uncertain"),skipped:n("skipped"),disabled:r.disabled||r.configured===false?1:0});
}
export const workerHttpStatus=(r:WorkerResult)=>r.status==="FAILED"||r.status==="PARTIAL_FAILURE"?503:200;
