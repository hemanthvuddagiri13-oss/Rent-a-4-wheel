import { deliverNoticeChannels } from "@/lib/notice-channels";
import {observeWorker} from "@/lib/observability";
import { timingSafeEqual } from "node:crypto";
import { projectTransactionalNotices } from "@/lib/notice-center";
import { runCollaborationRetention } from "@/lib/collaboration-retention";
import {workerHttpStatus,workerResult} from "@/lib/worker-result";
export async function POST(req: Request) {
 const secret=process.env.CRON_SECRET;if(!secret)return Response.json({error:"Cron not configured."},{status:503});
 const provided=Buffer.from(req.headers.get("authorization")??""),expected=Buffer.from(`Bearer ${secret}`);
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return Response.json({error:"Unauthorized"},{status:401});
 try{
  // A failed child does not erase outcomes from siblings which already committed.
  const child=async(run:()=>Promise<unknown>)=>{try{return await run();}catch{return workerResult({failed:1});}};
  const result=await observeWorker("community",async()=>({notifications:await child(projectTransactionalNotices),retention:await child(runCollaborationRetention),channels:await child(deliverNoticeChannels)}));
  return Response.json(result,{status:workerHttpStatus(result.worker)});
 }catch{return Response.json({error:"Retry required."},{status:503});}
}

export const GET = POST;
