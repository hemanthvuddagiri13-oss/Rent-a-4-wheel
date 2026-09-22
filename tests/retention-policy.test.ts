import {afterAll,afterEach,it,expect,vi} from "vitest";
import {PrismaClient} from "@prisma/client";
import {randomUUID} from "node:crypto";
import {lockRetentionPolicy,retentionApproved} from "@/lib/retention-policy";
import {runCollaborationRetention} from "@/lib/collaboration-retention";
import {policy} from "@/lib/collaboration-access";
import {fingerprint} from "@/lib/financial-operations";
import {prisma,createTestVehicle,createTestCustomer,createTestReservation} from "./helpers/factories";
import {fixtureJurisdiction} from "./helpers/jurisdiction-fixture";
import {barrier} from "./helpers/barrier";
const other=new PrismaClient();
afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await other.$disconnect();await prisma.$disconnect();});
async function fixture(){await fixtureJurisdiction(prisma,"OR");const customer=await createTestCustomer(),vehicle=await createTestVehicle({jurisdictionCode:"OR"}),r=await createTestReservation({customerId:customer.id,vehicleId:vehicle.id,pickupAt:new Date("2039-01-01"),returnAt:new Date("2039-01-02"),status:"COMPLETED"});const c=await prisma.conversation.create({data:{reservationId:r.id,vehicleId:vehicle.id,customerId:customer.id,closedAt:new Date(0),retainUntil:new Date(0)}});const message=await prisma.conversationMessage.create({data:{conversationId:c.id,senderId:customer.id,body:"Synthetic expired evidence"}});return {customer,r,c,message};}
async function approve(){const reviewer=await prisma.user.findUniqueOrThrow({where:{email:"jurisdiction-reviewer@fixtures.invalid"}});return prisma.policyApproval.create({data:{kind:"RETENTION",jurisdiction:"US-OR",version:randomUUID(),contentHash:fingerprint(await policy(prisma)),status:"APPROVED",approvedById:reviewer.id,approvedAt:new Date(),effectiveAt:new Date(),professionalReference:"SYNTHETIC TEST APPROVAL - NOT A REAL POLICY"}});}
it("retains expired content without exact schedule approval and permits approved recovery despite disabled admissions",async()=>{
 const f=await fixture();vi.stubEnv("APP_ENV","staging");
 // Expire any prior synthetic approval without changing historical evidence.
 await prisma.policyApproval.create({data:{kind:"RETENTION",jurisdiction:"US-OR",version:randomUUID(),contentHash:"0".repeat(64),status:"REVOKED",effectiveAt:new Date()}});
 await runCollaborationRetention();expect(await prisma.conversationMessage.findUnique({where:{id:f.message.id}})).not.toBeNull();
 const approval=await approve();await prisma.jurisdiction.update({where:{code:"OR"},data:{mode:"DISABLED"}});
 expect(await prisma.$transaction(async tx=>{await lockRetentionPolicy(tx);return retentionApproved(tx,f.r.id);})).toBe(true);
 await runCollaborationRetention();expect(await prisma.conversationMessage.findUnique({where:{id:f.message.id}})).toBeNull();
 await prisma.policyApproval.update({where:{id:approval.id},data:{status:"REVOKED"}});expect(await retentionApproved(prisma,f.r.id)).toBe(false);expect(await retentionApproved(prisma,null)).toBe(false);
 vi.stubEnv("APP_ENV","production");expect(await retentionApproved(prisma,f.r.id)).toBe(false);
 // Synthetic reservation and immutable audit evidence stay in the disposable database.
});
it("fences approval revocation against an active deletion authorization on separate PostgreSQL connections",async()=>{
 const f=await fixture(),approval=await approve();vi.stubEnv("APP_ENV","staging");const locked=barrier(),release=barrier();
 const authorize=other.$transaction(async tx=>{await lockRetentionPolicy(tx);expect(await retentionApproved(tx,f.r.id)).toBe(true);locked.release();await release.wait;},{timeout:15000});await locked.wait;
 const revoke=prisma.policyApproval.update({where:{id:approval.id},data:{status:"REVOKED"}}).then(row=>row);let waiting=false;
 try{for(let i=0;i<100;i++){const rows=await other.$queryRaw<Array<{n:bigint}>>`SELECT count(*) n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%PolicyApproval%'`;if(Number(rows[0].n)>0){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);}finally{release.release();}
 await Promise.all([authorize,revoke]);expect(await retentionApproved(prisma,f.r.id)).toBe(false);
});
