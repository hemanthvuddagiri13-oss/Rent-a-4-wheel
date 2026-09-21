import type {PrismaClient} from "@prisma/client";
import {JURISDICTION_GATES} from "@/lib/jurisdiction";
import {createHash} from "node:crypto";
/** Controlled test evidence only. Never invoked by seed or application code. */
export async function fixtureJurisdiction(db:PrismaClient,code="TX"){
 const reviewer=await db.user.upsert({where:{email:"jurisdiction-reviewer@fixtures.invalid"},create:{email:"jurisdiction-reviewer@fixtures.invalid",role:"SUPER_ADMIN"},update:{}});
 const jurisdiction=await db.jurisdiction.findUnique({where:{code}});
 if(!jurisdiction||jurisdiction.mode!=="STAGING")await db.jurisdiction.upsert({where:{code},create:{code,mode:"STAGING"},update:{mode:"STAGING"}});
 for(const category of JURISDICTION_GATES){
  const prior=await db.jurisdictionApproval.findFirst({where:{jurisdictionCode:code,category},orderBy:{version:"desc"}});
  if(prior?.status==="STAGING_READY"&&(!prior.endsAt||prior.endsAt>new Date()))continue;
  await db.jurisdictionApproval.create({data:{jurisdictionCode:code,category,version:(prior?.version??0)+1,status:"STAGING_READY",contentHash:createHash("sha256").update("CONTROLLED_TEST_FIXTURE:"+code+category).digest("hex"),reviewedById:reviewer.id,reviewedAt:new Date(),effectiveAt:new Date(0),evidenceReference:"CONTROLLED_TEST_FIXTURE_NOT_PRODUCTION_APPROVED"}});
 }
}
