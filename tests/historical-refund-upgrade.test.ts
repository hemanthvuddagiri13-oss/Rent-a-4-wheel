import {it,expect} from "vitest";
import {PrismaClient} from "@prisma/client";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import ts from "typescript";
import * as rules from "@/lib/finance-rules";
import * as locks from "@/lib/financial-locks";
import * as operations from "@/lib/financial-operations";
import * as movement from "@/lib/payout-movement";
import {accountReservation} from "@/lib/finance-ledger";
import {accountingCompleteness} from "@/lib/finance-completeness";

const BASE="f0255dc67c3af670c60df9d3238695e5f4d573fb";
it("upgrades actual rejected Phase 5 debit and credit refund postings without rewriting immutable journals",async()=>{
 const source=new URL(process.env.DIRECT_DATABASE_URL??process.env.DATABASE_URL!);if(!source.pathname.endsWith("_test"))throw new Error("Disposable database required");
 const name="historical_refund_"+randomUUID().replaceAll("-","").slice(0,12),adminUrl=new URL(source),target=new URL(source);adminUrl.pathname="/postgres";target.pathname="/"+name;
 const admin=new PrismaClient({datasources:{db:{url:adminUrl.toString()}}}),db=new PrismaClient({datasources:{db:{url:target.toString()}}});
 const directory=mkdtempSync(path.join(tmpdir(),"historical-refund-")),schema=path.join(directory,"prisma/schema.prisma");
 const git=(args:string[])=>execFileSync("git",args,{maxBuffer:8*1024*1024});
 for(const file of git(["ls-tree","-r","--name-only",BASE,"prisma/schema.prisma","prisma/migrations"]).toString().trim().split(/\r?\n/)){const dest=path.join(directory,file);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,git(["show",BASE+":"+file]));}
 const deploy=()=>execFileSync(process.execPath,["scripts/migrate.mjs","deploy","--schema",schema],{env:{...process.env,APP_ENV:"test",DATABASE_URL:adminUrl.toString(),DIRECT_DATABASE_URL:target.toString(),MIGRATION_CONNECTION_MODE:"direct"},timeout:120000,stdio:"pipe"});
 // Execute the exact historical ledger, allocator and certification source.
 // The generated current client omits only the later allocationEvidence column.
 const legacyDb=db.$extends({query:{ledgerJournal:{$allOperations({args,query}){if(!("select" in args&&args.select))Object.assign(args,{omit:{allocationEvidence:true}});return query(args);}}}}) as unknown as PrismaClient;
 const dependencies:Record<string,unknown>={"@/lib/finance-rules":rules,"@/lib/financial-locks":locks,"@/lib/financial-operations":operations,"@/lib/prisma":{prisma:legacyDb},"@/lib/payout-movement":movement};
 const load=(file:string)=>{const mod={exports:{}};const code=ts.transpileModule(git(["show",BASE+":"+file]).toString(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function("require","module","exports",code)((name:string)=>{if(!(name in dependencies))throw new Error("Unmapped historical dependency: "+name);return dependencies[name];},mod,mod.exports);return mod.exports;};
 dependencies["@/lib/marketplace-refund-allocation"]=load("src/lib/marketplace-refund-allocation.ts");
 dependencies["@/lib/finance-completeness"]=load("src/lib/finance-completeness.ts");
 const old=load("src/lib/finance-ledger.ts") as typeof import("@/lib/finance-ledger");
 try{
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);deploy();
  const originals=[];
  for(const kind of ["HOST_DEBIT","HOST_CREDIT"] as const){
   const id=kind,u="guest_"+id,h="host_"+id,v="vehicle_"+id,p="payment_"+id;
   for(const userId of [u,h,"proposer_"+id,"approver_"+id])await db.user.create({data:{id:userId,email:userId+"@historical.test",role:userId.startsWith("guest")?"CUSTOMER":userId.startsWith("host")?"HOST":"SUPER_ADMIN"}});
   await db.hostProfile.create({data:{id:h,userId:h,legalName:"Historical Independent Host"}});
   await db.vehicle.create({data:{id:v,hostId:h,slug:v,vin:v,licensePlate:v,year:2024,make:"Fixture",model:"Car",category:"SEDAN",dailyRateCents:10000,weeklyRateCents:50000,monthlyRateCents:100000}});
   await db.reservation.create({data:{id,confirmationNumber:id,customerId:u,vehicleId:v,pickupAt:new Date("2050-01-01"),returnAt:new Date("2050-01-02"),status:"COMPLETED",rateType:"DAILY",rateAmountCents:10000,units:1,subtotalCents:10000,totalCents:10000}});
   await db.financeQuote.create({data:{reservationId:id,terms:{commission:{engine:"MARKETPLACE_V1"},tax:{},settlement:{loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}},amounts:{grossCents:10000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1000,hostNetCents:9000,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:10000},approved:false}}});
   await db.payment.create({data:{id:p,reservationId:id,type:"RENTAL",status:"SUCCEEDED",amountCents:10000}});
   await locks.withReservationLock(id,tx=>old.accountReservation(tx,id),legacyDb);
   const evidence=await db.financialCase.create({data:{sourceKey:id,reservationId:id,customerId:u,kind:"SETTLEMENT",amountCents:4000,currency:"usd",reason:"Retained historical approval",status:"RESOLVED",resolution:"Independent evidence"}});
   await locks.withReservationLock(id,async tx=>{
    const a=await tx.financeAdjustment.create({data:{reservationId:id,kind,amountCents:4000,reason:"Retained historical approval",evidenceId:evidence.id,createdById:"proposer_"+id}});
    const credit=kind==="HOST_CREDIT",j=await old.journal(tx,{key:"adjustment:"+a.id,kind,currency:"usd",reservationId:id,hostId:h,description:a.reason,lines:credit?[{account:"PLATFORM_ADJUSTMENT_EXPENSE",debitCents:4000},{account:"HOST_PAYABLE",creditCents:4000}]:[{account:"HOST_PAYABLE",debitCents:4000},{account:"PLATFORM_ADJUSTMENT_RECOVERY",creditCents:4000}]});
    await tx.financeAdjustment.update({where:{id:a.id},data:{state:"APPROVED",approvedById:"approver_"+id,journalId:j.id}});await tx.hostEarning.update({where:{reservationId:id},data:{adjustmentCents:credit?4000:-4000}});
    await tx.auditLog.create({data:{actorId:"approver_"+id,action:"finance.adjustment.approved",entityType:"FinanceAdjustment",entityId:a.id,metadata:{journalId:j.id,reason:a.reason}}});
   },legacyDb);
   await db.refund.create({data:{id:"refund_"+id,reservationId:id,paymentId:p,amountCents:5000,status:"SUCCEEDED",reason:"Historical partial refund",idempotencyKey:"refund_"+id}});
   await locks.withReservationLock(id,tx=>old.accountReservation(tx,id),legacyDb);
   const journal=await legacyDb.ledgerJournal.findUniqueOrThrow({where:{key:"refund:refund_"+id},include:{lines:{orderBy:{id:"asc"}}}});
   expect(journal.lines.filter(l=>l.account==="HOST_PAYABLE").reduce((n,l)=>n+l.debitCents,0)).toBe(kind==="HOST_DEBIT"?2500:4500);
   originals.push({id,p,journal});
  }
  cpSync("prisma/migrations",path.join(directory,"prisma/migrations"),{recursive:true});writeFileSync(schema,readFileSync("prisma/schema.prisma"));deploy();
  for(const {id,p,journal} of originals){
   const before=await db.ledgerJournal.findUniqueOrThrow({where:{id:journal.id},include:{lines:{orderBy:{id:"asc"}}}});expect(before).toEqual({...journal,allocationEvidence:null});
   await locks.withReservationLock(id,tx=>accountReservation(tx,id),db);expect(await db.refundCompatibilityEvidence.count({where:{reservationId:id}})).toBe(1);
   for(const amount of [1000,4000]){await db.refund.create({data:{reservationId:id,paymentId:p,amountCents:amount,status:"SUCCEEDED",reason:"Post-upgrade refund",idempotencyKey:randomUUID()}});for(let n=0;n<2;n++)await locks.withReservationLock(id,tx=>accountReservation(tx,id),db);}
   expect((await locks.withReservationLock(id,tx=>accountingCompleteness(tx,id),db)).complete).toBe(true);
   expect((await db.hostEarning.findUniqueOrThrow({where:{reservationId:id}})).refundedCents).toBe(id==="HOST_DEBIT"?5000:9000);
   expect(await db.ledgerJournal.findUniqueOrThrow({where:{id:journal.id},include:{lines:{orderBy:{id:"asc"}}}})).toEqual(before);
  }
  console.info(JSON.stringify({historicalSource:BASE,compatibilityRecords:await db.refundCompatibilityEvidence.count(),historicalJournalsUnchanged:true}));
 }finally{await legacyDb.$disconnect();await db.$disconnect();try{await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);}finally{await admin.$disconnect();if(path.dirname(path.resolve(directory))!==path.resolve(tmpdir())||!path.basename(directory).startsWith("historical-refund-"))throw new Error("Unsafe cleanup");rmSync(directory,{recursive:true,force:true});}}
},240000);
