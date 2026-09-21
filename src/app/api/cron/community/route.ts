import { deliverNoticeChannels } from "@/lib/notice-channels";
import {observeWorker} from "@/lib/observability";
import { timingSafeEqual } from "node:crypto";
import { projectTransactionalNotices } from "@/lib/notice-center";
import { runCollaborationRetention } from "@/lib/collaboration-retention";
export async function POST(req: Request) {
 const secret=process.env.CRON_SECRET;if(!secret)return Response.json({error:"Cron not configured."},{status:503});
 const provided=Buffer.from(req.headers.get("authorization")??""),expected=Buffer.from(`Bearer ${secret}`);
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return Response.json({error:"Unauthorized"},{status:401});
 try{return Response.json(await observeWorker("community",async()=>({notifications:await projectTransactionalNotices(),retention:await runCollaborationRetention(),channels:await deliverNoticeChannels()})));}catch{return Response.json({error:"Retry required."},{status:503});}
}

export const GET = POST;
