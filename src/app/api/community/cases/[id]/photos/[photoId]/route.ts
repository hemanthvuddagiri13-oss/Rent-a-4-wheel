import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { caseAccess } from "@/lib/service-cases";
import { readPrivateDocument } from "@/lib/storage";
import { audit } from "@/lib/collaboration-access";
export async function GET(_req:Request,{params}:{params:Promise<{id:string;photoId:string}>}) {
 const user=(await auth())?.user;if(!user)return Response.json({error:"Not found."},{status:404});
 try{const {id,photoId}=await params;const photo=await prisma.$transaction(async tx=>{const {c}=await caseAccess(tx,user.id,id);if(!c.reservationId)throw new Error("Not found");const row=await tx.conditionPhoto.findFirst({where:{id:photoId,conditionReport:{reservationId:c.reservationId,acceptedAt:{not:null}}}});if(!row)throw new Error("Not found");await audit(tx,user.id,"case.original_evidence.read","ConditionPhoto",row.id);return row;});const file=await readPrivateDocument(photo.storageKey);return new Response(new Uint8Array(file.buffer),{headers:{"Content-Type":"application/octet-stream","Content-Disposition":"attachment; filename=trip-evidence.image","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});}catch{return Response.json({error:"Not found."},{status:404});}
}
