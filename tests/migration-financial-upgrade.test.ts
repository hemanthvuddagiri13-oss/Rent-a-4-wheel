import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
const root=path.resolve(__dirname,"..");
const migrations=readdirSync(path.join(root,"prisma/migrations")).filter(s=>/^\d/.test(s)).sort();
function url(name:string){const u=new URL(process.env.DATABASE_URL!);u.pathname='/'+name;return u.toString()}
function sql(db:string,args:string[]){execFileSync('psql',[db,'-v','ON_ERROR_STOP=1',...args],{stdio:'inherit'})}
describe('populated financial schema upgrades',()=>{
 it.each(['20260916210000_add_deposit_recovery_window_expired_reason','20260916220000_durable_financial_operations','20260917010000_financial_recovery_generations'])('quarantines unknown results and preserves known provider IDs upgrading %s',async cutoff=>{
  const name=`financial_upgrade_${Date.now()}_${Math.floor(Math.random()*1e6)}`,db=url(name);
  sql(url('postgres'),['-c',`CREATE DATABASE "${name}"`]);
  const client=new PrismaClient({datasources:{db:{url:db}}});
  try {
   for(const migration of migrations.filter(m=>m<=cutoff)){
    sql(db,['-f',path.join(root,'prisma/migrations',migration,'migration.sql')]);
    if(migration.endsWith('_init'))sql(db,['-f',path.join(root,'tests/fixtures/legacy-schema-seed.sql')]);
   }
   sql(db,['-c',`UPDATE "Refund" SET "status"='FAILED', "stripeRefundId"=NULL WHERE "id"='mig_test_refund';
    INSERT INTO "SecurityDeposit" ("id","reservationId","amountCents","status","updatedAt") VALUES ('legacy_unknown_deposit','mig_test_res_confirmed',30000,'FAILED',now());
    INSERT INTO "SecurityDeposit" ("id","reservationId","amountCents","status","stripePaymentIntentId","updatedAt") VALUES ('legacy_known_deposit','mig_test_res_active',30000,'SUCCEEDED','pi_legacy_known',now());
    INSERT INTO "Refund" ("id","reservationId","paymentId","amountCents","status","stripeRefundId","idempotencyKey","updatedAt") VALUES ('known_refund','mig_test_res_confirmed','mig_test_payment',1000,'PENDING','re_known','original-key',now());`]);
   if(cutoff >= "20260916220000_durable_financial_operations") sql(db,["-c",`INSERT INTO "FinancialOperation" ("id","key","kind","reservationId","fingerprint","payload","providerId","updatedAt") VALUES ('ambiguous-a','ambiguous-key-a','DEPOSIT','mig_test_res_active','a','{}','pi_legacy_known',now()),('ambiguous-b','ambiguous-key-b','DEPOSIT','mig_test_res_active','b','{}','pi_legacy_known',now());`]);
   for(const migration of migrations.filter(m=>m>cutoff))sql(db,['-f',path.join(root,'prisma/migrations',migration,'migration.sql')]);
   const unknown=await client.securityDeposit.findUniqueOrThrow({where:{id:'legacy_unknown_deposit'}});
   expect(unknown.legacyUncertain).toBe(true);expect(unknown.stripePaymentIntentId).toBeNull();
   expect((await client.reservation.findUniqueOrThrow({where:{id:'mig_test_res_confirmed'}})).financialDisposition).toBe('REVIEW');
   const refund=await client.refund.findUniqueOrThrow({where:{id:'mig_test_refund'}});
   expect(refund.legacyUncertain).toBe(true);expect(refund.idempotencyKey).toBe('legacy-mig_test_refund');expect(refund.status).toBe('FAILED');expect(await client.financialCase.count({where:{refundId:refund.id}})).toBe(1);
   expect((await client.refund.findUniqueOrThrow({where:{id:'known_refund'}})).stripeRefundId).toBe('re_known');
   expect((await client.securityDeposit.findUniqueOrThrow({where:{id:'legacy_known_deposit'}})).stripePaymentIntentId).toBe('pi_legacy_known');
   expect(await client.financialOperation.count()).toBe(cutoff >= "20260916220000_durable_financial_operations" ? 2 : 0);
   const ambiguous=await client.securityDeposit.findUniqueOrThrow({where:{id:"legacy_known_deposit"}});expect(ambiguous.legacyUncertain).toBe(true);expect(ambiguous.operationId).toBeNull();
  } finally {await client.$disconnect();sql(url('postgres'),['-c',`DROP DATABASE "${name}"`])}
 },120000);
});
