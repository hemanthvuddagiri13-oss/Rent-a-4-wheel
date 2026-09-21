import {observeWorker} from "@/lib/observability";
import { timingSafeEqual } from "node:crypto";
import { payoutWorkers } from "@/lib/payout-workers";
export async function POST(req:Request,{params}:{params:Promise<{worker:string}>}){const key=process.env.CRON_SECRET;if(!key)return Response.json({error:"Cron unavailable"},{status:503});const expected=Buffer.from("Bearer "+key),actual=Buffer.from(req.headers.get("authorization")??"");if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:"Unauthorized"},{status:401});const {worker}=await params;if(!Object.hasOwn(payoutWorkers,worker))return Response.json({error:"Unknown worker"},{status:404});try{return Response.json(await observeWorker<unknown>("payouts/"+worker,()=>payoutWorkers[worker as keyof typeof payoutWorkers]()));}catch{return Response.json({error:"Worker remains pending; inspect finance reconciliation."},{status:503});}}
export const GET=POST;

