// One bounded invocation for an external scheduler. No shell interpolation of secrets.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const manifest=JSON.parse(readFileSync(new URL("../vercel.json",import.meta.url),"utf8"));
export const scheduledPaths=Object.freeze(manifest.crons.map(row=>row.path));
export async function dispatchCron(worker,env=process.env,request=fetch){
 const path="/api/cron/"+worker;
 if(!scheduledPaths.includes(path))throw new Error("UNKNOWN_SCHEDULE");
 const url=new URL(env.SITE_URL??"");
 if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("INVALID_SCHEDULER_ORIGIN");
 if(!env.CRON_SECRET||env.CRON_SECRET.length<32)throw new Error("INVALID_SCHEDULER_SECRET");
 const response=await request(new URL(path,url),{method:"POST",headers:{authorization:"Bearer "+env.CRON_SECRET},redirect:"error",signal:AbortSignal.timeout(300000)});
 // Never emit provider/body data. A non-success exit is actionable by the scheduler.
 if(!response.ok){await response.body?.cancel();throw new Error("CRON_HTTP_"+response.status);}
 // Partial failure is actionable too: schedule another bounded invocation, never
 // blindly resend REVIEW/uncertain deliveries. Read only a bounded result body.
 const reader=response.body?.getReader();let text="",bytes=0;
 if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536)throw new Error("CRON_RESULT_TOO_LARGE");text+=new TextDecoder().decode(value);}}finally{await reader.cancel();}
 const result=text?JSON.parse(text):{};
 if(["FAILED","PARTIAL_FAILURE"].includes(result.worker?.status??result.status))throw new Error("CRON_WORKER_"+(result.worker?.status??result.status));
 return {worker,status:response.status};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await dispatchCron(process.argv[2])));}
 catch{console.error(JSON.stringify({category:"SCHEDULE_FAILED"}));process.exitCode=1;}
}
