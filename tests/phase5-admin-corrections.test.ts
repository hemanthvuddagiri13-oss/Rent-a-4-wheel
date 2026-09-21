import {afterAll,afterEach,it,expect,vi} from "vitest";
import bcrypt from "bcryptjs";
import {prisma,createTestCustomer} from "./helpers/factories";
import {createDeviceSession} from "@/lib/device-sessions";
import {PrismaClient,type Prisma} from "@prisma/client";
import {prisma as appDb} from "@/lib/prisma";
import {recordAgreementAcceptance} from "@/lib/agreements";
import {createTestVehicle} from "./helpers/factories";
import {barrier} from "./helpers/barrier";
const identity=vi.hoisted(()=>({session:{} as unknown,origin:"http://localhost:3000"}));
vi.mock("@/auth",()=>({auth:async()=>identity.session}));
vi.mock("next/headers",()=>({headers:async()=>new Headers({origin:identity.origin})}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import {POST} from "@/app/api/admin/operations/route";
import {updateSettings} from "@/app/admin/settings/actions";
import {updateLegalDocument} from "@/app/admin/legal/actions";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(()=>prisma.$disconnect());
async function actor(){
 const user=await createTestCustomer({role:"SUPER_ADMIN"}),s=await createDeviceSession(user.id);
 identity.session={user,sessionId:s.sid,credentialVersion:s.rotation};
 identity.origin=new URL(process.env.SITE_URL??process.env.AUTH_URL??process.env.NEXTAUTH_URL??"http://localhost:3000").origin;
 await prisma.authCode.create({data:{email:user.email,purpose:"SECURITY_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
 return user;
}
it("refuses a real release route mutation without explicit confirmation",async()=>{
 await actor();const before=await prisma.releaseFeature.findUnique({where:{key:"reviews"}});
 const response=await POST(new Request(identity.origin+"/api/admin/operations",{method:"POST",headers:{origin:identity.origin,"content-type":"application/json"},body:JSON.stringify({action:"feature",key:"reviews",enabled:!before?.enabled,code:"123456",reason:"Controlled correction regression"})}));
 expect(response.status).toBe(409);
 expect(await prisma.releaseFeature.findUnique({where:{key:"reviews"}})).toEqual(before);
});
it.each(["policy","jurisdictionMode","jurisdictionGate","pricingPolicy","revokeJurisdictionGate","revokePricingPolicy","retry"])("the real %s route refuses missing step-up without changing authority or recovery jobs",async action=>{
 const user=await actor(),last=await prisma.jurisdictionApproval.findFirst({where:{jurisdictionCode:"NV",category:"LEGAL"},orderBy:{version:"desc"}});
 const gate=await prisma.jurisdictionApproval.create({data:{jurisdictionCode:"NV",category:"LEGAL",version:(last?.version??0)+1,status:"SAMPLE",contentHash:"a".repeat(64),effectiveAt:new Date(),evidenceReference:"Controlled test evidence"}});
 const fee={basisPoints:0,flatCents:0,minimumCents:0,maximumCents:10000},config={currency:"usd",hostCommission:fee,guestService:fee,subscriptions:[],volumeTiers:[],jurisdictionAdjustment:{hostCommissionBps:0,guestServiceFlatCents:0},protection:fee,processing:{fee,allocation:"PLATFORM"},taxes:{basisPoints:0,extrasTaxable:false,guestServiceTaxable:false,protectionTaxable:false,processingTaxable:false},riskReserve:fee,promotions:{hostShareBps:0},settlement:{delayDays:1,refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:false}};
 const previous=await prisma.marketplacePricingPolicy.findFirst({where:{jurisdictionCode:"NV"},orderBy:{version:"desc"}});
 const policy=await prisma.marketplacePricingPolicy.create({data:{jurisdictionCode:"NV",version:(previous?.version??0)+1,status:"SAMPLE",config,contentHash:"a".repeat(64),effectiveAt:new Date(),createdById:user.id}});
 const job=await prisma.operationsJob.create({data:{key:crypto.randomUUID(),kind:"SCAN",state:"REVIEW"}});
 const common={jurisdictionCode:"NV",confirm:true,reason:"Controlled route regression"},effectiveAt=new Date().toISOString();
 const payloads:Record<string,object>={policy:{action,kind:"PRIVACY",version:"1.0",contentHash:"a".repeat(64),professionalReference:"Synthetic controlled evidence",effectiveAt,jurisdiction:"US-NV",confirm:true,reason:common.reason},jurisdictionMode:{...common,action,mode:"STAGING"},jurisdictionGate:{...common,action,category:"LEGAL",status:"STAGING_READY",contentHash:"a".repeat(64),evidenceReference:"Synthetic controlled evidence",effectiveAt},pricingPolicy:{...common,action,config,status:"SAMPLE",effectiveAt},revokeJurisdictionGate:{...common,action,id:gate.id},revokePricingPolicy:{...common,action,id:policy.id},retry:{action,key:job.key,confirm:true,reason:common.reason}};
 const snapshot=()=>Promise.all([prisma.policyApproval.findMany({orderBy:{id:"asc"}}),prisma.jurisdiction.findMany({orderBy:{code:"asc"}}),prisma.jurisdictionApproval.findMany({orderBy:{id:"asc"}}),prisma.marketplacePricingPolicy.findMany({orderBy:{id:"asc"}}),prisma.operationsJob.findMany({orderBy:{key:"asc"}})]);
 const before=await snapshot();
 const response=await POST(new Request(identity.origin+"/api/admin/operations",{method:"POST",headers:{origin:identity.origin,"content-type":"application/json"},body:JSON.stringify(payloads[action])}));
 expect(response.status).toBe(409);
 expect(await snapshot()).toEqual(before);
});
it("the real legal server action refuses missing security proof and sanitizes invalid input",async()=>{
 await actor();const doc=await prisma.legalDocument.upsert({where:{type:"TERMS_AND_CONDITIONS"},create:{type:"TERMS_AND_CONDITIONS",title:"Fixture",content:"Controlled terms",version:"1",needsAttorneyReview:true},update:{}});
 const form=new FormData();for(const [key,value]of Object.entries({type:doc.type,content:"Changed terms",version:"2",needsAttorneyReview:"on",confirm:"true",reason:"Controlled legal regression"}))form.set(key,value);
 await expect(updateLegalDocument(form)).rejects.toThrow("ADMIN_MUTATION_REFUSED");
 form.set("type","untrusted-secret-fixture");await expect(updateLegalDocument(form)).rejects.toThrow(/^ADMIN_MUTATION_REFUSED$/);
 expect(await prisma.legalDocument.findUnique({where:{id:doc.id}})).toEqual(doc);
});

it("serializes the real legacy legal edit and signing without a release/document deadlock",async()=>{
 const user=await actor(),vehicle=await createTestVehicle(),other=new PrismaClient();
 const content="Controlled synthetic agreement "+crypto.randomUUID();
 await prisma.legalDocument.upsert({where:{type:"HOST_AGREEMENT"},create:{type:"HOST_AGREEMENT",title:"Fixture",content:"Old fixture",version:"1",needsAttorneyReview:false},update:{content:"Old fixture",needsAttorneyReview:false}});
 const form=new FormData();for(const [key,value]of Object.entries({type:"HOST_AGREEMENT",content,version:crypto.randomUUID(),reviewReference:"Synthetic counsel evidence only",code:"123456",confirm:"true",reason:"Controlled legal correction"}))form.set(key,value);
 const entered=barrier(),release=barrier();let readerPid=0;
 const original=appDb.$transaction.bind(appDb);
 const intercepted=(async(callback:(tx:Prisma.TransactionClient)=>Promise<unknown>)=>original(async tx=>callback(new Proxy(tx,{get(target,key){
  if(key==="$queryRaw")return async(...args:Parameters<Prisma.TransactionClient["$queryRaw"]>)=>{
   const result=await target.$queryRaw(...args);
   if(String(args[0]).includes("LegalDocument")&&String(args[0]).includes("FOR UPDATE")){entered.release();await release.wait;}
   return result;
  };
  return Reflect.get(target,key);
 }})),{timeout:15000})) as typeof appDb.$transaction;
 vi.spyOn(appDb,"$transaction").mockImplementation(intercepted);
 const editing=updateLegalDocument(form);const editResult=Promise.allSettled([editing]);await entered.wait;
 const signing=other.$transaction(async tx=>{readerPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() pid`)[0].pid;return recordAgreementAcceptance(tx,{type:"HOST_AGREEMENT",vehicleId:vehicle.id,signedByUserId:user.id,signerName:"Fixture Signer",ipAddress:null,userAgent:null});},{timeout:15000});
 const signResult=Promise.allSettled([signing]);
 try{
  let blocked=false;for(let n=0;n<200;n++){const rows=await prisma.$queryRaw<Array<{waiting:boolean}>>`SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=${readerPid}`;if(rows[0]?.waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(blocked).toBe(true);
 }finally{release.release();}
 try{
  expect((await editResult)[0].status).toBe("fulfilled");
  const result=(await signResult)[0];expect(result.status,result.status==="rejected"?String(result.reason):"").toBe("fulfilled");
  if(result.status==="fulfilled")expect(result.value.contentSnapshot).toBe(content);
 }finally{await other.$disconnect();}
});
it("legacy settings action cannot mutate without step-up, confirmation and reason",async()=>{
 await actor();const before=await prisma.siteSetting.findMany({orderBy:{key:"asc"}});
 const form=new FormData();for(const [key,value]of Object.entries({businessName:"Unapproved change",phone:"5555555555",email:"fixture@example.com",address:"Fixture",operatingHours:"Fixture",taxRatePercent:"0",defaultDeposit:"0",minimumAge:"21",checkInWindowHours:"24",mileagePolicySummary:"Fixture",cancellationPolicySummary:"Fixture",bookingTimezone:"America/Chicago"}))form.set(key,value);
 await expect(updateSettings(form)).rejects.toThrow();
 expect(await prisma.siteSetting.findMany({orderBy:{key:"asc"}})).toEqual(before);
});
it("legacy legal action cannot edit with a stale SUPER_ADMIN page after role revocation",async()=>{
 const user=await actor();const doc=await prisma.legalDocument.upsert({where:{type:"PRIVACY_POLICY"},create:{type:"PRIVACY_POLICY",title:"Fixture",content:"Controlled synthetic policy",version:"1",needsAttorneyReview:true},update:{}});
 await prisma.user.update({where:{id:user.id},data:{role:"CUSTOMER"}});
 const form=new FormData();for(const [key,value]of Object.entries({type:doc.type,content:"Changed controlled synthetic policy",version:crypto.randomUUID(),needsAttorneyReview:"on",code:"123456",confirm:"true",reason:"Controlled correction regression"}))form.set(key,value);
 await expect(updateLegalDocument(form)).rejects.toThrow();
 expect(await prisma.legalDocument.findUnique({where:{id:doc.id}})).toEqual(doc);
});

async function featureRequest(overrides:Record<string,unknown>={},origin=identity.origin){
 return POST(new Request(identity.origin+"/api/admin/operations",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({action:"feature",key:"reviews",enabled:false,code:"123456",confirm:true,reason:"Controlled security regression",...overrides})}));
}
it.each(["missing-code","wrong-purpose","short-reason","missing-reason","cross-origin","revoked-session","revoked-role"])("rejects protected route with %s and no mutation",async(kind)=>{
 const user=await actor(),before=await prisma.releaseFeature.findUnique({where:{key:"reviews"}}),auditBefore=await prisma.auditLog.count({where:{actorId:user.id}});
 const overrides:Record<string,unknown>={};let origin=identity.origin;
 if(kind==="missing-code")overrides.code="";
 if(kind==="short-reason")overrides.reason="short";
 if(kind==="missing-reason")overrides.reason=undefined;
 if(kind==="cross-origin")origin="https://untrusted.invalid";
 if(kind==="wrong-purpose")await prisma.authCode.updateMany({where:{email:user.email},data:{purpose:"FINANCE_STEP_UP"}});
 if(kind==="revoked-session")await prisma.session.updateMany({where:{userId:user.id},data:{revokedAt:new Date()}});
 if(kind==="revoked-role")await prisma.user.update({where:{id:user.id},data:{role:"ADMIN"}});
 expect([403,409]).toContain((await featureRequest(overrides,origin)).status);
 expect(await prisma.releaseFeature.findUnique({where:{key:"reviews"}})).toEqual(before);
 expect(await prisma.auditLog.count({where:{actorId:user.id}})).toBe(auditBefore);
});
it("a code authorizes one mutation only and the protected audit cannot be changed or removed",async()=>{
 const user=await actor();expect((await featureRequest()).status).toBe(200);
 const before=await prisma.releaseFeature.findUnique({where:{key:"reviews"}});
 expect((await featureRequest({enabled:true})).status).toBe(409);
 expect(await prisma.releaseFeature.findUnique({where:{key:"reviews"}})).toEqual(before);
 const audit=await prisma.auditLog.findFirstOrThrow({where:{actorId:user.id,action:"protected.admin.feature"}});
 await expect(prisma.auditLog.update({where:{id:audit.id},data:{metadata:{reason:"tamper"}}})).rejects.toThrow("immutable");
 await expect(prisma.auditLog.delete({where:{id:audit.id}})).rejects.toThrow("immutable");
});
it("rolls back the feature update when the final audit insert fails in PostgreSQL",async()=>{
 await actor();const before=await prisma.releaseFeature.findUnique({where:{key:"reviews"}});
 const original=appDb.$transaction.bind(appDb);
 vi.spyOn(appDb,"$transaction").mockImplementation((async(callback:(tx:Prisma.TransactionClient)=>Promise<unknown>)=>original(async tx=>callback(new Proxy(tx,{get(target,key){
  if(key==="auditLog")return new Proxy(target.auditLog,{get(delegate,method){
   if(method==="create")return async(args:Prisma.AuditLogCreateArgs)=>{if(args.data.action.startsWith("protected.admin."))await tx.$executeRawUnsafe("SELECT 1 / 0");return delegate.create(args);};
   return Reflect.get(delegate,method);
  }});return Reflect.get(target,key);
 }})))) as typeof appDb.$transaction);
 const response=await featureRequest();expect(response.status).toBe(409);
 expect(await response.text()).not.toMatch(/division|SELECT|123456|DATABASE/);
 expect(await prisma.releaseFeature.findUnique({where:{key:"reviews"}})).toEqual(before);
});
it("rechecks a revoked session after waiting for the authority fence",async()=>{
 const user=await actor(),other=new PrismaClient(),entered=barrier(),release=barrier();
 const before=await prisma.releaseFeature.findUnique({where:{key:"reviews"}});
 const holding=other.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;entered.release();await release.wait;},{timeout:15000});
 await entered.wait;const response=featureRequest();
 try{
  let blocked=false;for(let n=0;n<300;n++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;if(rows.length){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(blocked).toBe(true);
  await prisma.session.updateMany({where:{userId:user.id},data:{revokedAt:new Date()}});
 }finally{release.release();await holding;}
 try{expect((await response).status).toBe(409);expect(await prisma.releaseFeature.findUnique({where:{key:"reviews"}})).toEqual(before);}finally{await other.$disconnect();}
});
