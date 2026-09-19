import { it,expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
it("upgrades populated Phase 3 without rewriting financial or signed evidence and enforces new journal constraints",async()=>{
 const name="finance_upgrade_"+Date.now(),admin=new URL(process.env.DATABASE_URL!),target=new URL(admin);admin.pathname="/postgres";target.pathname="/"+name;
 const sql=(url:string,args:string[])=>execFileSync("psql",[url,"-v","ON_ERROR_STOP=1",...args],{stdio:"inherit"});sql(admin.toString(),["-c",'CREATE DATABASE "'+name+'"']);const db=new PrismaClient({datasources:{db:{url:target.toString()}}});
 const migrations=readdirSync("prisma/migrations").filter(m=>/^\d/.test(m)).sort();
 try{
  for(const m of migrations.filter(m=>m<"20260926010000")){sql(target.toString(),["-f",path.resolve("prisma/migrations",m,"migration.sql")]);if(m.endsWith("_init"))sql(target.toString(),["-f",path.resolve("tests/fixtures/legacy-schema-seed.sql")]);}
  const snapshot=async()=>({reservations:await db.reservation.findMany({orderBy:{id:"asc"}}),payments:await db.payment.findMany({orderBy:{id:"asc"}}),refunds:await db.refund.findMany({orderBy:{id:"asc"}}),agreements:await db.agreementAcceptance.findMany({orderBy:{id:"asc"}}),documents:await db.driverDocument.findMany({orderBy:{id:"asc"}})});
  const before=await snapshot();expect(before.reservations.length).toBeGreaterThan(0);expect(before.payments.length).toBeGreaterThan(0);expect(before.agreements.length).toBeGreaterThan(0);
  for(const m of migrations.filter(m=>m>="20260926010000"))sql(target.toString(),["-f",path.resolve("prisma/migrations",m,"migration.sql")]);expect(await snapshot()).toEqual(before);expect(await db.financeSnapshot.count()).toBe(0);expect(await db.payoutBatch.count()).toBe(0);
  await db.$transaction(async tx=>{await tx.ledgerJournal.create({data:{id:"balanced",key:"balanced",kind:"MIGRATION_TEST",currency:"usd",description:"Balanced fixture",fingerprint:"balanced",lines:{create:[{account:"CASH",debitCents:100},{account:"PAYABLE",creditCents:100}]}}});});
  await expect(db.ledgerJournal.update({where:{id:"balanced"},data:{description:"Mutated"}})).rejects.toThrow("Immutable");
  await expect(db.$transaction(tx=>tx.ledgerJournal.create({data:{key:"unbalanced",kind:"MIGRATION_TEST",currency:"usd",description:"Rejected fixture",fingerprint:"bad",lines:{create:[{account:"CASH",debitCents:100},{account:"PAYABLE",creditCents:99}]}}}))).rejects.toThrow("balance");
 }finally{await db.$disconnect();sql(admin.toString(),["-c",'DROP DATABASE "'+name+'"']);}
},120000);
