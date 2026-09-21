import { it,expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

it("preserves populated payout evidence, backfills owned bank generations and quarantines historical deficits",async()=>{
 const name="payout_projection_upgrade_"+Date.now(),admin=new URL(process.env.DATABASE_URL!),target=new URL(admin);admin.pathname="/postgres";target.pathname="/"+name;
 const sql=(url:string,args:string[])=>execFileSync("psql",[url,"-v","ON_ERROR_STOP=1",...args],{stdio:"inherit"});sql(admin.toString(),["-c",'CREATE DATABASE "'+name+'"']);
 const db=new PrismaClient({datasources:{db:{url:target.toString()}}}),last="20260927010000_payout_projection_authority";
 try{
  for(const m of readdirSync("prisma/migrations").filter(m=>/^\d/.test(m)&&m<last).sort()){
   sql(target.toString(),["-f",path.resolve("prisma/migrations",m,"migration.sql")]);if(m.endsWith("_init"))sql(target.toString(),["-f",path.resolve("tests/fixtures/legacy-schema-seed.sql")]);
  }
  const user=await db.user.create({data:{email:"migration-payout@example.test",role:"HOST"}}),host=await db.hostProfile.create({select:{id:true},data:{userId:user.id,legalName:"Migration Host"}}),reservations=await db.reservation.findMany({select:{id:true},take:2});expect(reservations).toHaveLength(2);
  for(let n=0;n<2;n++)await db.$transaction(async tx=>{
   const id="migration-batch-"+n,reservationId=reservations[n].id,providerId="po_migration_"+n,status=n?"paid":"pending";
   await tx.hostEarning.create({data:{id:"migration-earning-"+n,reservationId,hostId:host.id,grossCents:15000,commissionCents:1500,hostDiscountCents:0,netCents:13500}});
   await tx.$executeRaw`INSERT INTO "PayoutBatch" (id,"hostId","accountId",currency,"amountCents","updatedAt") VALUES (${id},${host.id},'acct_migration','usd',13500,CURRENT_TIMESTAMP)`;
   await tx.payoutItem.create({data:{batchId:id,earningId:"migration-earning-"+n,reservationId,amountCents:13500}});
   await tx.$executeRaw`UPDATE "PayoutBatch" SET state=${n?"PAID":"PAYOUT_PENDING"},"transferredCents"=13500,"paidCents"=${n?13500:0},"reversedCents"=${n?4500:0},"payoutId"=${providerId} WHERE id=${id}`;
   await tx.financialOperation.create({data:{id:"migration-bank-"+n,key:`payout:${id}:1`,kind:"FINANCE_PAYOUT",fingerprint:"fixture-"+n,state:"OBSERVED",payload:{hostId:host.id,batchId:id,accountId:"acct_migration",amount:13500,currency:"usd"},result:{id:providerId,status,amount:13500,currency:"usd"}}});
   await tx.financialOperation.update({where:{id:"migration-bank-"+n},data:{providerId}});
  });
  const evidence=await db.financialOperation.findMany({where:{kind:"FINANCE_PAYOUT"},orderBy:{id:"asc"}});
  sql(target.toString(),["-f",path.resolve("prisma/migrations",last,"migration.sql")]);
  expect(await db.financialOperation.findMany({where:{kind:"FINANCE_PAYOUT"},orderBy:{id:"asc"}})).toEqual(evidence);
  expect(await db.payoutBankProjection.count()).toBe(2);expect(await db.payoutBatch.findUnique({where:{id:"migration-batch-0"}})).toMatchObject({pendingBankCents:13500,paidCents:0});
  expect(await db.payoutBatch.findUnique({where:{id:"migration-batch-1"}})).toMatchObject({paidCents:13500,reversedCents:4500});
  expect(await db.financeIssue.findUnique({where:{key:"bank-movement:migration-batch-1"}})).toMatchObject({status:"OPEN",kind:"BANK_MOVEMENT_INCOMPLETE"});
  expect(await db.accountingCheckpoint.count()).toBe(0);
  await expect(db.payoutBatch.update({where:{id:"migration-batch-0"},data:{reversalReservedCents:1}})).rejects.toThrow("payout_available_funds_nonnegative");
 }finally{await db.$disconnect();sql(admin.toString(),["-c",'DROP DATABASE "'+name+'"']);}
},120000);
