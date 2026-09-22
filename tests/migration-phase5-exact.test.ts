import {it,expect,vi} from "vitest";
import {PrismaClient} from "@prisma/client";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";

const state=vi.hoisted(()=>({db:null as PrismaClient|null,retrieve:vi.fn(),create:vi.fn()}));
vi.mock("@/lib/prisma",async original=>{
 const actual=await original<typeof import("@/lib/prisma")>();
 return {...actual,prisma:new Proxy({},{get(_target,key){if(!state.db)throw new Error("Upgrade database not selected");const value=Reflect.get(state.db,key);return typeof value==="function"?value.bind(state.db):value;}})};
});
vi.mock("@/lib/stripe",()=>({stripe:{refunds:{retrieve:state.retrieve,create:state.create}}}));
import {fingerprint} from "@/lib/financial-operations";
import {accountReservation} from "@/lib/finance-ledger";
import {withReservationLock} from "@/lib/financial-locks";
import {executeRefundOperation} from "@/lib/refund-operations";

const BASE="c68b12200a36bd3e45f94292047dc03538908a29";
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const quote={commission:{legacy:true},tax:{legacy:true},settlement:{delayDays:7,loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}},amounts:{grossCents:15000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1500,hostNetCents:13500,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:15000},approved:false};

// Current generated client only selects old columns while seeding the exact
// historical database. No Phase 5 table/column is fabricated before deployment.
async function populate(db:PrismaClient){
 const id={id:true} as const;
 await db.user.create({data:{id:"guest",email:"phase5-upgrade-guest@example.com",role:"CUSTOMER"},select:id});
 await db.user.create({data:{id:"host-user",email:"phase5-upgrade-host@example.com",role:"HOST"},select:id});
 await db.hostProfile.create({data:{id:"host",userId:"host-user",legalName:"Synthetic Independent Provider",onboardingStatus:"APPROVED"},select:id});
 await db.vehicle.create({data:{id:"vehicle",slug:"phase5-upgrade",vin:"UPGRADEPHASE500001",licensePlate:"SYNTHETIC",year:2024,make:"Fixture",model:"Car",category:"SEDAN",status:"ACTIVE",hostId:"host",dailyRateCents:5000,weeklyRateCents:30000,monthlyRateCents:90000},select:id});
 for(const [index,status] of (["ACTIVE","COMPLETED","CANCELLED_BY_CUSTOMER","AWAITING_PAYMENT"] as const).entries()){
  const reservationId="r"+index;
  await db.reservation.create({data:{id:reservationId,confirmationNumber:"UPGRADE-"+index,vehicleId:"vehicle",customerId:"guest",status,pickupAt:new Date(Date.UTC(2045,index,1)),returnAt:new Date(Date.UTC(2045,index,4)),rateType:"DAILY",rateAmountCents:5000,units:3,subtotalCents:15000,totalCents:15000,financialDisposition:index===2?"REFUND_REQUIRED":"OPEN"},select:id});
  await db.financeQuote.create({data:{reservationId,terms:quote},select:{reservationId:true}});
  await db.financeSnapshot.create({data:{reservationId,hostId:"host",...quote,contentHash:fingerprint(quote)},select:{reservationId:true}});
  await db.payment.create({data:{id:"p"+index,reservationId,type:"RENTAL",status:index===3?"PROCESSING":"SUCCEEDED",amountCents:15000,stripePaymentIntentId:"pi_upgrade_"+index},select:id});
  if(index===3)continue;
  const input={key:"payment:p"+index,kind:"RENTAL_PAYMENT",currency:"usd",reservationId,hostId:"host",providerId:"pi_upgrade_"+index,description:"Customer rental payment and frozen allocation",lines:[{account:"STRIPE_CLEARING",debitCents:15000,creditCents:0},{account:"HOST_PAYABLE",debitCents:0,creditCents:13500},{account:"COMMISSION_REVENUE",debitCents:0,creditCents:1500}]};
  const {lines,...header}=input;
  await db.$transaction(tx=>tx.ledgerJournal.create({data:{id:"journal"+index,...header,fingerprint:fingerprint(input),lines:{create:lines}},select:id}));
  await db.hostEarning.create({data:{id:"earning"+index,reservationId,hostId:"host",grossCents:15000,commissionCents:1500,hostDiscountCents:0,netCents:13500},select:id});
 }
 for(const [index,status]of (["PENDING","SUCCEEDED"] as const).entries()){
  const key="refund-upgrade-"+index,refundId="refund"+index,providerId="re_upgrade_"+index;
  await db.refund.create({data:{id:refundId,reservationId:"r2",paymentId:"p2",amountCents:index===0?10000:5000,status,stripeRefundId:providerId,idempotencyKey:key,reason:"Synthetic cancellation"},select:id});
  const input={key,kind:"REFUND",reservationId:"r2",payload:{refundId,paymentIntentId:"pi_upgrade_2",amount:index===0?10000:5000}};
  const result={id:providerId,status:status==="PENDING"?"pending":"succeeded",amount:input.payload.amount,currency:"usd",payment_intent:"pi_upgrade_2"};
  await db.financialOperation.create({data:{id:"refund-op"+index,...input,fingerprint:fingerprint(input),state:status==="PENDING"?"RETRY":"OBSERVED",providerId,result,priority:10,firstAttemptAt:new Date("2026-01-01"),dispatches:{create:{leaseToken:"historical-token",phase:"SUCCEEDED",providerId,result}}},select:id});
 }
 // The completed refund already has its immutable accounting projection.
 const refundInput={key:"refund:refund1",kind:"REFUND",currency:"usd",reservationId:"r2",hostId:"host",providerId:"re_upgrade_1",description:"Refund reduces pending host earnings",lines:[{account:"HOST_PAYABLE",debitCents:4500,creditCents:0},{account:"PLATFORM_REFUND_COST",debitCents:500,creditCents:0},{account:"STRIPE_CLEARING",debitCents:0,creditCents:5000}]};
 const {lines,...header}=refundInput;
 await db.$transaction(tx=>tx.ledgerJournal.create({data:{...header,fingerprint:fingerprint(refundInput),lines:{create:lines}},select:id}));
 await db.hostEarning.update({where:{id:"earning2"},data:{refundedCents:4500},select:id});
 for(const index of [0,1]){
  await db.securityDeposit.create({data:{id:"deposit"+index,reservationId:"r"+index,amountCents:30000,status:index===0?"SUCCEEDED":"CANCELLED",stripePaymentIntentId:"pi_deposit_"+index,stripeStatus:index===0?"requires_capture":"canceled",capturableAmountCents:index===0?30000:0,authorizedAt:new Date("2045-01-01"),authorizationExpiresAt:new Date("2045-01-08"),releasedAt:index===1?new Date("2045-02-05"):null},select:id});
 }
 await db.$transaction(async tx=>{
  await tx.payoutBatch.create({data:{id:"batch",hostId:"host",accountId:"acct_synthetic",currency:"usd",amountCents:13500,state:"PLANNED"},select:id});
  await tx.payoutItem.create({data:{batchId:"batch",earningId:"earning1",reservationId:"r1",amountCents:13500},select:id});
  await tx.payoutBatch.update({where:{id:"batch"},data:{transferredCents:13500,pendingBankCents:10000,generation:2,state:"PAYOUT_PENDING",transferId:"tr_upgrade",payoutId:"po_upgrade_2"},select:id});
 });
 for(const generation of [1,2]){
  const input={key:"payout:batch:"+generation,kind:"FINANCE_PAYOUT",payload:{batchId:"batch",hostId:"host",accountId:"acct_synthetic",amount:10000,currency:"usd"}};
  await db.financialOperation.create({data:{id:"payout-op"+generation,...input,fingerprint:fingerprint(input),generation},select:id});
  await db.financialOperation.update({where:{id:"payout-op"+generation},data:{state:"OBSERVED",providerId:"po_upgrade_"+generation,result:{id:"po_upgrade_"+generation,amount:10000,currency:"usd",status:generation===1?"failed":"pending"}},select:id});
  await db.payoutBankProjection.create({data:{operationId:"payout-op"+generation,batchId:"batch",providerId:"po_upgrade_"+generation,currency:"usd",amountCents:10000,status:generation===1?"failed":"pending"},select:{operationId:true}});
 }
 await db.$executeRaw`INSERT INTO "Session" (id,"sessionToken","userId",expires) VALUES ('session','legacy-device-token','guest','2045-01-01')`;
 const content="Synthetic historical terms, not legal approval";
 await db.legalDocument.create({data:{type:"RENTAL_AGREEMENT",version:"fixture1",title:"Synthetic terms",content,needsAttorneyReview:true},select:id});
 for(const complete of [false,true])await db.agreementAcceptance.create({data:{id:complete?"signed-pdf":"missing-pdf",type:"RENTAL_AGREEMENT",reservationId:complete?"r1":"r0",documentVersion:"fixture1",contentHash:sha(content),contentSnapshot:content,signedByUserId:"guest",signerName:"Synthetic Signer",subjectSnapshot:{reservationId:complete?"r1":"r0",totalCents:15000},signedPdfStorageKey:complete?"s3:legacy-signed.pdf":null},select:id});
 await db.driverDocument.create({data:{id:"identity",userId:"guest",reservationId:"r0",type:"LICENSE_FRONT",storageKey:"s3:legacy-identity.png",mimeType:"image/png",contentSha256:"a".repeat(64),fileSizeBytes:100,malwareScanStatus:"QUARANTINED",retentionExpiresAt:new Date("2048-01-01")},select:id});
 await db.marketplaceFile.create({data:{hostId:"host",vehicleId:"vehicle",uploadedById:"host-user",purpose:"INSURANCE",storageKey:"s3:legacy-insurance.pdf",mimeType:"application/pdf",sha256:"b".repeat(64),scanStatus:"QUARANTINED"},select:id});
 await db.serviceCase.create({data:{id:"claim",kind:"CLAIM",reservationId:"r0",vehicleId:"vehicle",openedById:"guest",category:"DAMAGE",title:"Historical claim",details:{evidence:"Synthetic retained evidence"},dueAt:new Date("2045-01-09"),retainUntil:new Date("2048-01-01"),legalHold:true,securityHold:true},select:id});
 await db.collaborationFile.create({data:{caseId:"claim",uploadedById:"guest",purpose:"CLAIM",storageKey:"s3:legacy-claim.png",mimeType:"image/png",sha256:"c".repeat(64),size:100,scanStatus:"QUARANTINED",retainUntil:new Date("2048-01-01"),legalHold:true},select:id});
}

it("deploys the exact approved populated Phase 4 through all nine Phase 5 and additive correction migrations without losing evidence",async()=>{
 const source=new URL(process.env.DIRECT_DATABASE_URL??process.env.DATABASE_URL!);
 if(!source.pathname.endsWith("_test"))throw new Error("Disposable database required");
 const name="phase5_exact_"+randomUUID().replaceAll("-","").slice(0,12),adminUrl=new URL(source),target=new URL(source);
 adminUrl.pathname="/postgres";target.pathname="/"+name;
 const admin=new PrismaClient({datasources:{db:{url:adminUrl.toString()}}}),db=new PrismaClient({datasources:{db:{url:target.toString()}}});
 const directory=mkdtempSync(path.join(tmpdir(),"phase5-upgrade-")),schema=path.join(directory,"prisma/schema.prisma");
 const git=(args:string[])=>execFileSync("git",args,{maxBuffer:5*1024*1024});
 const baselineFiles=git(["ls-tree","-r","--name-only",BASE,"prisma/schema.prisma","prisma/migrations"]).toString().trim().split(/\r?\n/);
 const baselineHashes=new Map<string,string>();
 for(const file of baselineFiles){const bytes=git(["show",BASE+":"+file]);baselineHashes.set(file,sha(bytes));const destination=path.join(directory,file);mkdirSync(path.dirname(destination),{recursive:true});writeFileSync(destination,bytes);}
 const deploy=()=>execFileSync(process.execPath,["scripts/migrate.mjs","deploy","--schema",schema],{env:{...process.env,APP_ENV:"test",DATABASE_URL:adminUrl.toString(),DIRECT_DATABASE_URL:target.toString(),MIGRATION_CONNECTION_MODE:"direct"},timeout:120000,stdio:"pipe"});
 try{
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);deploy();
  expect(await db.$queryRaw`SELECT to_regclass('public."PrivateObject"')::text AS name`).toEqual([{name:null}]);
  await populate(db);
  const columns=await db.$queryRaw<Array<{table_name:string;column_name:string}>>`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name<>'_prisma_migrations' ORDER BY table_name,ordinal_position`;
  const tables=new Map<string,string[]>();for(const c of columns)tables.set(c.table_name,[...(tables.get(c.table_name)??[]),c.column_name]);
  const evidence=async()=>{
   const result:Record<string,unknown>={};
   for(const [table,fields]of tables){const rows=await db.$queryRawUnsafe<Array<{row:unknown}>>(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields.map(c=>'"'+c+'"').join(",")} FROM "${table}") t ORDER BY to_jsonb(t)::text`);if(rows.length)result[table]=rows;}
   return result;
  };
  const before=await evidence();expect(Object.keys(before).length).toBeGreaterThanOrEqual(20);
  const migrations=readdirSync("prisma/migrations").filter(m=>/^20260928/.test(m));expect(migrations).toHaveLength(9);
  cpSync("prisma/migrations",path.join(directory,"prisma/migrations"),{recursive:true});writeFileSync(schema,readFileSync("prisma/schema.prisma"));
  for(const [file,hash]of baselineHashes)if(file!=="prisma/schema.prisma")expect(sha(readFileSync(path.join(directory,file))),file+" remains byte-identical").toBe(hash);
  deploy();expect(await evidence()).toEqual(before);
  const applied=await db.$queryRaw<Array<{migration_name:string}>>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  for(const migration of readdirSync("prisma/migrations").filter(m=>/^\d/.test(m)))expect(applied.some(row=>row.migration_name===migration)).toBe(true);
  expect((await db.session.findUniqueOrThrow({where:{id:"session"}})).revokedAt).not.toBeNull();
  expect(await db.jurisdiction.count({where:{mode:"DISABLED"}})).toBe(51);
  expect(await db.jurisdictionApproval.count()).toBe(0);expect(await db.marketplacePricingPolicy.count({where:{status:"APPROVED"}})).toBe(0);
  expect(await db.vehicle.findUniqueOrThrow({where:{id:"vehicle"}})).toMatchObject({jurisdictionCode:null});
  expect(await db.privateObject.count()).toBe(0);expect(await db.privateValidation.count()).toBe(0);
  expect(await db.operationsJob.findUniqueOrThrow({where:{key:"agreement:missing-pdf"}})).toMatchObject({state:"PENDING"});
  expect(await db.operationsJob.count({where:{key:"agreement:signed-pdf"}})).toBe(0);
  await expect(db.$executeRaw`UPDATE "LedgerJournal" SET description='tamper' WHERE id='journal0'`).rejects.toThrow("Immutable");
  await expect(db.$executeRaw`UPDATE "PayoutBatch" SET "pendingBankCents"=14000 WHERE id='batch'`).rejects.toThrow();
  state.db=db;vi.stubEnv("DIRECT_DATABASE_URL",target.toString());vi.stubEnv("DATABASE_URL",target.toString());
  state.retrieve.mockResolvedValue({id:"re_upgrade_0",status:"succeeded",amount:10000,currency:"usd",payment_intent:"pi_upgrade_2"});
  expect((await executeRefundOperation("refund0","pi_upgrade_2")).status).toBe("SUCCEEDED");
  expect((await executeRefundOperation("refund0","pi_upgrade_2")).status).toBe("already_terminal");
  expect((await executeRefundOperation("refund1","pi_upgrade_2")).status).toBe("already_terminal");
  expect(state.retrieve).toHaveBeenCalledTimes(1);expect(state.create).not.toHaveBeenCalled();
  const initialJournalCount=await db.ledgerJournal.count({where:{reservationId:"r2"}});
  await withReservationLock("r2",tx=>accountReservation(tx,"r2"),db);
  await withReservationLock("r2",tx=>accountReservation(tx,"r2"),db);
  expect(await db.ledgerJournal.count({where:{reservationId:"r2"}})).toBe(initialJournalCount+1);
  expect(await db.hostEarning.findUniqueOrThrow({where:{id:"earning2"}})).toMatchObject({refundedCents:13500});
  expect(await db.reservation.findUniqueOrThrow({where:{id:"r2"}})).toMatchObject({status:"CANCELLED_BY_CUSTOMER",financialDisposition:"TERMINATED"});
  expect(await db.payoutBatch.findUniqueOrThrow({where:{id:"batch"}})).toMatchObject({pendingBankCents:10000,generation:2,paidCents:0});
  const journalRows=await db.ledgerJournal.findMany({include:{lines:true}});for(const j of journalRows)expect(j.lines.reduce((sum,line)=>sum+line.debitCents-line.creditCents,0)).toBe(0);
  console.info(JSON.stringify({migrationBase:BASE,phase5Migrations:migrations.length,preservedTables:Object.keys(before).length,refundReads:state.retrieve.mock.calls.length,refundCreates:state.create.mock.calls.length}));
 }finally{
  state.db=null;vi.unstubAllEnvs();await db.$disconnect();
  try{await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);}finally{await admin.$disconnect();if(path.dirname(path.resolve(directory))!==path.resolve(tmpdir())||!path.basename(directory).startsWith("phase5-upgrade-"))throw new Error("Unsafe temporary cleanup path");rmSync(directory,{recursive:true,force:true});}
 }
},240000);
