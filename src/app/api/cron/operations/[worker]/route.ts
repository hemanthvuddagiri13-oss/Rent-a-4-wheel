import {monitorOperations,observeWorker} from "@/lib/observability";
import { authenticatedCron } from "@/lib/security-request";
import { runOperations } from "@/lib/operations";
import { safeLog } from "@/lib/safe-log";
export async function POST(req:Request,{params}:{params:Promise<{worker:string}>}){
 if(!authenticatedCron(req.headers))return Response.json({error:"Unauthorized"},{status:401});
 const {worker}=await params;
 try{if(worker==="scan")return Response.json(await observeWorker("operations/scan",()=>runOperations("SCAN")));if(worker==="delete")return Response.json(await observeWorker("operations/delete",()=>runOperations("DELETE")));if(worker==="monitor")return Response.json(await observeWorker("operations/monitor",monitorOperations));return Response.json({error:"Not found"},{status:404});}catch(error){safeLog("CRON_FAILED",error);return Response.json({error:"Worker requires retry"},{status:503});}
}
export const GET=POST;
