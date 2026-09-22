import {monitorOperations,observeWorker,failedWorkerBatch} from "@/lib/observability";
import { authenticatedCron } from "@/lib/security-request";
import { runOperations } from "@/lib/operations";
import { safeLog } from "@/lib/safe-log";
export async function POST(req:Request,{params}:{params:Promise<{worker:string}>}){
 if(!authenticatedCron(req.headers))return Response.json({error:"Unauthorized"},{status:401});
 const {worker}=await params;
 try{
  if(!["agreements","scan","delete","monitor"].includes(worker))return Response.json({error:"Not found"},{status:404});
  const result=await observeWorker("operations/"+worker,async()=>worker==="monitor"?monitorOperations():runOperations(worker==="agreements"?"AGREEMENT":worker==="scan"?"SCAN":"DELETE"));
  return Response.json(result,{status:failedWorkerBatch(result)?503:200});
 }catch(error){safeLog("CRON_FAILED",error);return Response.json({error:"Worker requires retry"},{status:503});}
}
export const GET=POST;
