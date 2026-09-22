import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revokeDeviceSessions } from "@/lib/device-sessions";
import { requestAuthCode } from "@/lib/auth-code";
import { requestOriginAllowed } from "@/lib/security-request";
import { boundedBody } from "@/lib/bounded-request";
export async function GET() {
  const session = await auth(); if (!session?.user) return Response.json({error:"Unauthorized"},{status:401});
  const rows = await prisma.session.findMany({where:{userId:session.user.id,revokedAt:null,expires:{gt:new Date()},lastSeenAt:{gt:new Date(Date.now()-30*60000)}},select:{id:true,device:true,createdAt:true,lastSeenAt:true,expires:true},orderBy:{createdAt:"desc"}});
  return Response.json({sessions:rows.map(row=>({...row,current:row.id===session.sessionId}))},{headers:{"Cache-Control":"no-store"}});
}
export async function POST(req:Request) {
  const session=await auth();if(!session?.user)return Response.json({error:"Unauthorized"},{status:401});
  if(!requestOriginAllowed(req))return Response.json({error:"Invalid origin"},{status:403});
  try {
    const body=JSON.parse((await boundedBody(req,2048)).toString("utf8"));
    if(body.action==="stepUp"){const user=await prisma.user.findUniqueOrThrow({where:{id:session.user.id}});const result=await requestAuthCode({email:user.email,ip:null,purpose:"SECURITY_STEP_UP"});return Response.json({success:result.ok},{status:result.ok?200:429});}
    if(body.action!=="revoke"&&body.action!=="revokeAll")return Response.json({error:"Invalid action"},{status:400});
    if(body.action==="revoke"&&(typeof body.id!=="string"||body.id.length>100))return Response.json({error:"Invalid session"},{status:400});
    return Response.json({revoked:await revokeDeviceSessions(session.user.id,body.action==="revoke"?body.id:undefined)});
  } catch {return Response.json({error:"Security action unavailable"},{status:503});}
}
