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
 await response.body?.cancel();
 if(!response.ok)throw new Error("CRON_HTTP_"+response.status);
 return {worker,status:response.status};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await dispatchCron(process.argv[2])));}
 catch{console.error(JSON.stringify({category:"SCHEDULE_FAILED"}));process.exitCode=1;}
}
