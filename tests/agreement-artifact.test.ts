import {afterAll,it,expect} from "vitest";
import {PrismaClient} from "@prisma/client";
import {createHash} from "node:crypto";
import {generateSignedAgreementArtifact} from "@/lib/agreement-artifact";
import {runOperations} from "@/lib/operations";
import {readPrivateDocument} from "@/lib/storage";
import {prisma,createTestCustomer,createTestVehicle} from "./helpers/factories";
import {barrier} from "./helpers/barrier";
const other=new PrismaClient();afterAll(async()=>{await other.$disconnect();await prisma.$disconnect();});
async function acceptance(){const user=await createTestCustomer(),vehicle=await createTestVehicle();return prisma.agreementAcceptance.create({data:{type:"HOST_AGREEMENT",vehicleId:vehicle.id,signedByUserId:user.id,signerName:"Synthetic signer",documentVersion:"fixture",contentSnapshot:"Synthetic agreement, not legal language",contentHash:"a".repeat(64),subjectSnapshot:{vehicle:{id:vehicle.id,listingRevision:0}}}});}
it("resumes persisted exact PDF bytes after provider storage succeeds but attachment projection fails",async()=>{
 const a=await acceptance();expect(a.id).toMatch(/^[a-z0-9]+$/);
 await prisma.operationsJob.create({data:{key:"agreement:"+a.id,kind:"AGREEMENT",resourceId:a.id,nextAttemptAt:new Date(0)}});
 await prisma.$executeRawUnsafe(`CREATE FUNCTION test_artifact_projection_loss() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic projection loss'; END $$`);
 await prisma.$executeRawUnsafe(`CREATE TRIGGER test_artifact_projection BEFORE UPDATE ON "AgreementAcceptance" FOR EACH ROW WHEN (NEW.id='${a.id}') EXECUTE FUNCTION test_artifact_projection_loss()`);
 try{await expect(generateSignedAgreementArtifact(a.id)).rejects.toThrow("DATABASE_OPERATION_FAILED");}finally{await prisma.$executeRawUnsafe('DROP TRIGGER test_artifact_projection ON "AgreementAcceptance"');await prisma.$executeRawUnsafe("DROP FUNCTION test_artifact_projection_loss()");}
 const frozen=await prisma.agreementArtifact.findUniqueOrThrow({where:{acceptanceId:a.id}}),key="local:"+frozen.storageId+".pdf";
 expect((await prisma.privateObject.findUniqueOrThrow({where:{key}})).writeState).toBe("STORED");expect((await prisma.agreementAcceptance.findUniqueOrThrow({where:{id:a.id}})).signedPdfStorageKey).toBeNull();
 await runOperations("AGREEMENT");expect((await prisma.agreementAcceptance.findUniqueOrThrow({where:{id:a.id}})).signedPdfStorageKey).toBe(key);
 expect((await prisma.operationsJob.findUniqueOrThrow({where:{key:"agreement:"+a.id}})).state).toBe("DONE");
 expect(createHash("sha256").update((await readPrivateDocument(key)).buffer).digest("hex")).toBe(frozen.sha256);
 await expect(prisma.agreementArtifact.update({where:{acceptanceId:a.id},data:{pdf:Buffer.from("replacement")}})).rejects.toThrow("immutable");
});
it("serializes simultaneous generators using separate PostgreSQL sessions and produces one immutable object",async()=>{
 const a=await acceptance(),entered=barrier(),release=barrier();const blocker=other.$transaction(async tx=>{await tx.$queryRaw`SELECT financial_guard_xact(${"agreement-artifact:"+a.id})`;entered.release();await release.wait;},{timeout:15000});await entered.wait;
 const one=generateSignedAgreementArtifact(a.id),two=generateSignedAgreementArtifact(a.id);let count=0;
 try{for(let i=0;i<100;i++){const rows=await other.$queryRaw<Array<{n:bigint}>>`SELECT count(*) n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%financial_guard_xact%'`;count=Number(rows[0].n);if(count>=2)break;await new Promise(r=>setTimeout(r,10));}expect(count).toBeGreaterThanOrEqual(2);}finally{release.release();}
 await Promise.all([blocker,one,two]);expect(await prisma.agreementArtifact.count({where:{acceptanceId:a.id}})).toBe(1);expect(await prisma.privateObject.count({where:{key:"local:agreement-"+a.id+".pdf"}})).toBe(1);
 expect((await prisma.agreementAcceptance.findUniqueOrThrow({where:{id:a.id}})).signedPdfStorageKey).toBe("local:agreement-"+a.id+".pdf");
});
