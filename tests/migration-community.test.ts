import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

it("adds Phase 3 to populated Phase 2 without rewriting money, documents or signed agreements",async()=>{
 const name="community_upgrade_"+Date.now(),admin=new URL(process.env.DATABASE_URL!),target=new URL(admin);admin.pathname="/postgres";target.pathname="/"+name;
 const sql=(url:string,args:string[])=>execFileSync("psql",[url,"-v","ON_ERROR_STOP=1",...args],{stdio:"inherit"});
 sql(admin.toString(),["-c",'CREATE DATABASE "'+name+'"']);
 const db=new PrismaClient({datasources:{db:{url:target.toString()}}});
 const migrations=readdirSync("prisma/migrations").filter(m=>/^\d/.test(m)).sort();
 try {
  for(const m of migrations.filter(m=>m<"20260924010000")){sql(target.toString(),["-f",path.resolve("prisma/migrations",m,"migration.sql")]);if(m.endsWith("_init"))sql(target.toString(),["-f",path.resolve("tests/fixtures/legacy-schema-seed.sql")]);}
  const snapshot=async()=>({reservations:await db.reservation.findMany({omit:{jurisdictionCode:true,jurisdictionSnapshot:true},orderBy:{id:"asc"}}),payments:await db.payment.findMany({orderBy:{id:"asc"}}),refunds:await db.refund.findMany({orderBy:{id:"asc"}}),documents:await db.driverDocument.findMany({orderBy:{id:"asc"}}),agreements:await db.agreementAcceptance.findMany({orderBy:{id:"asc"}})});
  const before=await snapshot();expect(before.reservations.length).toBeGreaterThan(0);expect(before.payments.length).toBeGreaterThan(0);expect(before.documents.length).toBeGreaterThan(0);expect(before.agreements.length).toBeGreaterThan(0);
  for(const m of migrations.filter(m=>m>="20260924010000")) {
   if(m==="20260925010000_case_conflict_history") {
    await db.user.create({data:{id:"history-host",email:"history-host@migration.test",role:"HOST"}});
    await db.user.create({data:{id:"history-employee",email:"history-employee@migration.test",role:"HOST_EMPLOYEE"}});
    await db.hostProfile.create({select:{id:true},data:{id:"history-host-profile",userId:"history-host",legalName:"Historical host"}});
    await db.hostEmployee.create({data:{hostId:"history-host-profile",userId:"history-employee",isActive:false}});
   }
   sql(target.toString(),["-f",path.resolve("prisma/migrations",m,"migration.sql")]);
  }
  expect(await db.$queryRaw`SELECT "hostId","userId" FROM "HostAffiliationHistory" WHERE "userId"='history-employee'`).toEqual([{hostId:"history-host-profile",userId:"history-employee"}]);
  await db.hostEmployee.deleteMany({where:{userId:"history-employee"}});
  expect(await db.$queryRaw`SELECT "hostId","userId" FROM "HostAffiliationHistory" WHERE "userId"='history-employee'`).toEqual([{hostId:"history-host-profile",userId:"history-employee"}]);
  expect(await snapshot()).toEqual(before);expect(await db.financialOperation.count()).toBe(0);expect(await db.tripReview.count()).toBe(0);expect(await db.inboxNotice.count()).toBe(0);
  const agent=await db.user.create({data:{email:"claims@migration.test",role:"CLAIMS_AGENT"}});expect(agent.role).toBe("CLAIMS_AGENT");
  const r=before.reservations[0];const c=await db.conversation.create({data:{reservationId:r.id,vehicleId:r.vehicleId,customerId:r.customerId,retainUntil:new Date(Date.now()+86400000)}});
  await expect(db.conversation.create({data:{reservationId:r.id,vehicleId:r.vehicleId,customerId:r.customerId,retainUntil:new Date()}})).rejects.toThrow();
  const m=await db.conversationMessage.create({data:{conversationId:c.id,senderId:r.customerId,body:"Preserved conversation history"}});
  const revision=await db.messageRevision.create({data:{messageId:m.id,actorId:r.customerId,version:0,body:m.body,action:"SEND"}});
  await expect(db.messageRevision.update({where:{id:revision.id},data:{body:"Changed"}})).rejects.toThrow("immutable");
 } finally {await db.$disconnect();sql(admin.toString(),["-c",'DROP DATABASE "'+name+'"']);}
},120000);
