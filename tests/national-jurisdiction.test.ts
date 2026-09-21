import { afterAll, afterEach, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { jurisdictionDecision, JURISDICTION_GATES } from "@/lib/jurisdiction";
import { createOrRefreshHold } from "@/lib/checkout-hold";
import { saveHostProfile } from "@/lib/marketplace";
import { getVehicleBySlug } from "@/lib/data/vehicles";
import { createTestCustomer, createTestVehicle, prisma } from "./helpers/factories";
import { fixtureJurisdiction } from "./helpers/jurisdiction-fixture";
import { barrier } from "./helpers/barrier";
const other=new PrismaClient(),observer=new PrismaClient();
afterEach(()=>vi.unstubAllEnvs());
afterAll(async()=>{await Promise.all([other.$disconnect(),observer.$disconnect(),prisma.$disconnect()]);});
it("contains all 50 states and DC, rejects unknown codes and cannot enable production",async()=>{
 expect(await prisma.jurisdiction.count()).toBe(51);
 await expect(prisma.$transaction(tx=>jurisdictionDecision(tx,"XX","CHECKOUT"))).rejects.toThrow("Jurisdiction");
 await expect(prisma.jurisdiction.update({where:{code:"CA"},data:{mode:"PRODUCTION"}})).rejects.toThrow();
 await fixtureJurisdiction(prisma,"OR");vi.stubEnv("APP_ENV","production");
 await expect(prisma.$transaction(tx=>jurisdictionDecision(tx,"OR","CHECKOUT"))).rejects.toThrow("Jurisdiction");
});
it("requires each independent gate and does not fall back to older evidence after expiry or revocation",async()=>{
 await fixtureJurisdiction(prisma,"OR");
 for(const category of JURISDICTION_GATES){
  const gate=await prisma.jurisdictionApproval.findFirstOrThrow({where:{jurisdictionCode:"OR",category},orderBy:{version:"desc"}});
  await prisma.jurisdictionApproval.update({where:{id:gate.id},data:{status:"REVOKED"}});
  await expect(prisma.$transaction(tx=>jurisdictionDecision(tx,"OR","CHECKOUT"))).rejects.toThrow("Jurisdiction");
  await fixtureJurisdiction(prisma,"OR");
 }
 const gate=await prisma.jurisdictionApproval.findFirstOrThrow({where:{jurisdictionCode:"OR",category:"TAX"},orderBy:{version:"desc"}});
 await prisma.jurisdictionApproval.create({data:{jurisdictionCode:"OR",category:"TAX",version:gate.version+1,status:"STAGING_READY",contentHash:gate.contentHash,reviewedById:gate.reviewedById,reviewedAt:new Date(),effectiveAt:new Date(0),endsAt:new Date(1),evidenceReference:"CONTROLLED_EXPIRED_FIXTURE"}});
 await expect(prisma.$transaction(tx=>jurisdictionDecision(tx,"OR","CHECKOUT"))).rejects.toThrow("Jurisdiction");
 await fixtureJurisdiction(prisma,"OR");
});
it("disabled state blocks onboarding, public vehicle visibility and hold creation",async()=>{
 const vehicle=await createTestVehicle({jurisdictionCode:"CA"}),customer=await createTestCustomer();
 await prisma.jurisdiction.update({where:{code:"CA"},data:{mode:"DISABLED"}});
 expect(await getVehicleBySlug(vehicle.slug)).toBeNull();
 await expect(saveHostProfile(customer.id,{legalName:"Synthetic Provider",businessName:"Independent Host",phone:"5555555555",addressLine1:"Synthetic street",city:"Synthetic city",state:"CA",zip:"00000"})).rejects.toThrow("Jurisdiction");
 await expect(createOrRefreshHold({customerId:customer.id,vehicleId:vehicle.id,pickupAt:new Date("2035-01-01"),returnAt:new Date("2035-01-02"),extraIds:[]})).rejects.toThrow();
 expect(await prisma.reservation.count({where:{vehicleId:vehicle.id}})).toBe(0);
 await prisma.vehicle.delete({where:{id:vehicle.id}});await prisma.user.delete({where:{id:customer.id}});
});
it.each(["disable","revoke"] as const)("%s waits for a real admitted operation on a different connection, then fences all later actions",async action=>{
 await fixtureJurisdiction(prisma,"OR");const ready=barrier(),release=barrier();let firstPid=0,secondPid=0;
 const admitted=prisma.$transaction(async tx=>{firstPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;await jurisdictionDecision(tx,"OR","PAYMENT");ready.release();await release.wait;},{timeout:15000});
 await ready.wait;
 const change=other.$transaction(async tx=>{secondPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;if(action==="disable")await tx.jurisdiction.update({where:{code:"OR"},data:{mode:"DISABLED"}});else {const gate=await tx.jurisdictionApproval.findFirstOrThrow({where:{jurisdictionCode:"OR",category:"PAYMENTS"},orderBy:{version:"desc"}});await tx.jurisdictionApproval.update({where:{id:gate.id},data:{status:"REVOKED"}});}},{timeout:15000});
 let waiting=false;try{for(let i=0;i<200;i++){const rows=await observer.$queryRaw<Array<{waiting:boolean}>>`SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=${secondPid}`;if(rows[0]?.waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);expect(firstPid).not.toBe(secondPid);}finally{release.release();}
 await Promise.all([admitted,change]);
 for(const scope of ["HOSTING","ACTIVATION","SEARCH","CHECKOUT","PAYMENT","CONFIRMATION","TRIP_START","PAYOUT"] as const)await expect(prisma.$transaction(tx=>jurisdictionDecision(tx,"OR",scope))).rejects.toThrow("Jurisdiction");
 await fixtureJurisdiction(prisma,"OR");
});
