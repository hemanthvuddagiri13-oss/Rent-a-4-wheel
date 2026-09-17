import { projectTransactionalNotices } from "@/lib/notice-center";
import { enqueueOutboxNotification } from "@/lib/outbox";
import { GET as openNotice } from "@/app/api/community/notices/[id]/route";
import { runCollaborationRetention } from "@/lib/collaboration-retention";
import { communityAdmin } from "@/lib/community-admin";
import bcrypt from "bcryptjs";
import { createHmac } from "node:crypto";
import { readCollaborationFile } from "@/lib/collaboration-files";
import { deliverNoticeChannels } from "@/lib/notice-channels";
import { POST as smsWebhook } from "@/app/api/community/sms/route";
import { afterAll, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma,createTestHost,createTestCustomer,createTestVehicle,createTestReservation,cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { openConversation,messageCommand,readConversation,conversationAccess } from "@/lib/conversations";
import { createServiceCase,caseCommand,readServiceCase } from "@/lib/service-cases";
import { saveTripReview,publicTripReviews } from "@/lib/trip-reviews";
import { withReservationLock,assertFinancialTripStart } from "@/lib/financial-locks";
import { assertNoUnresolvedFinancialReview } from "@/lib/return-financial-authority";
import { fileHeld } from "@/lib/collaboration-retention";
const privateDelete=vi.hoisted(()=>vi.fn(async(key:string)=>{void key;}));
const privateRead=vi.hoisted(()=>vi.fn(async()=>({buffer:Buffer.from("private evidence")})));
vi.mock("@/lib/storage",async original=>({...await original<typeof import("@/lib/storage")>(),readPrivateDocument:privateRead,deletePrivateDocument:privateDelete}));
const session=vi.hoisted(()=>({id:""}));vi.mock("@/auth",()=>({auth:async()=>session.id ? {user:{id:session.id}} : null}));
import { POST } from "@/app/api/community/route";
import { POST as cron } from "@/app/api/cron/community/route";
const users:string[]=[],hosts:string[]=[],vehicles:string[]=[];
const one=new PrismaClient(),two=new PrismaClient();
afterAll(async()=>{
 const cs=await prisma.serviceCase.findMany({where:{openedById:{in:users}}});const ids=cs.map(c=>c.id);
 const conv=await prisma.conversation.findMany({where:{customerId:{in:users}}});const cids=conv.map(c=>c.id);
 const messages=await prisma.conversationMessage.findMany({where:{conversationId:{in:cids}}});
 await prisma.storageDeletionJob.deleteMany({where:{fileId:{in:(await prisma.collaborationFile.findMany({where:{uploadedById:{in:users}}})).map(f=>f.id)}}});
 await prisma.collaborationFile.deleteMany({where:{uploadedById:{in:users}}});
 await prisma.messageRevision.deleteMany({where:{messageId:{in:messages.map(m=>m.id)}}});
 await prisma.conversationMessage.deleteMany({where:{conversationId:{in:cids}}});await prisma.conversationRead.deleteMany({where:{conversationId:{in:cids}}});await prisma.conversation.deleteMany({where:{id:{in:cids}}});
 await prisma.serviceCaseEvent.deleteMany({where:{caseId:{in:ids}}});await prisma.serviceCase.updateMany({where:{id:{in:ids}},data:{linkedCaseId:null}});await prisma.serviceCase.deleteMany({where:{id:{in:ids}}});
 const reviews=await prisma.tripReview.findMany({where:{reviewerId:{in:users}}});await prisma.reviewHistory.deleteMany({where:{reviewId:{in:reviews.map(r=>r.id)}}});await prisma.tripReview.deleteMany({where:{id:{in:reviews.map(r=>r.id)}}});
 await prisma.channelDelivery.deleteMany({where:{userId:{in:users}}});await prisma.noticePreference.deleteMany({where:{userId:{in:users}}});await prisma.smsConsent.deleteMany({where:{userId:{in:users}}});
 await prisma.privacyDeletion.deleteMany({where:{userId:{in:users}}});
 await prisma.inboxNotice.deleteMany({where:{userId:{in:users}}});await prisma.communityReport.deleteMany({where:{actorId:{in:users}}});
 for(const userId of users)await prisma.outboxMessage.deleteMany({where:{payload:{path:["userId"],equals:userId}}});
 await cleanupReservationsForVehicles(vehicles);await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.hostEmployee.deleteMany({where:{hostId:{in:hosts}}});await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.hostProfile.deleteMany({where:{id:{in:hosts}}});await prisma.authCode.deleteMany({where:{email:{in:(await prisma.user.findMany({where:{id:{in:users}},select:{email:true}})).map(u=>u.email)}}});await prisma.user.deleteMany({where:{id:{in:users}}});await one.$disconnect();await two.$disconnect();await prisma.$disconnect();
});
async function fixture(status:"ACTIVE"|"COMPLETED"="ACTIVE"){
 const h=await createTestHost(),customer=await createTestCustomer(),other=await createTestCustomer(),agent=await createTestCustomer({role:"CLAIMS_AGENT"}),support=await createTestCustomer({role:"SUPPORT_AGENT"});users.push(h.user.id,customer.id,other.id,agent.id,support.id);hosts.push(h.hostProfile.id);
 const v=await createTestVehicle({hostId:h.hostProfile.id,listingApproval:"APPROVED"});vehicles.push(v.id);
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date(Date.now()-86400000),returnAt:new Date(),status});
 await prisma.trip.create({data:{reservationId:r.id,startedAt:new Date(Date.now()-86400000),...(status==="COMPLETED"?{endedAt:new Date()}: {})}});
 return {h,customer,other,agent,support,v,r};
}
it("isolates conversations from unrelated customers and hosts and revokes employees immediately",async()=>{
 const f=await fixture(),g=await fixture();const c=await openConversation(f.customer.id,{reservationId:f.r.id});
 await expect(readConversation(f.other.id,c.id)).rejects.toThrow("Not found");await expect(readConversation(g.h.user.id,c.id)).rejects.toThrow("Not found");
 await prisma.user.update({where:{id:f.other.id},data:{role:"HOST_EMPLOYEE"}});const e=await prisma.hostEmployee.create({data:{hostId:f.h.hostProfile.id,userId:f.other.id,role:"STAFF"}});
 await expect(conversationAccess(prisma,f.other.id,c.id)).resolves.toMatchObject({role:"HOST"});await prisma.hostEmployee.delete({where:{id:e.id}});await expect(conversationAccess(prisma,f.other.id,c.id)).rejects.toThrow();
});
it("preserves message history, rejects scripts and records soft deletion without destroying evidence",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id});await expect(messageCommand(f.customer.id,c.id,{action:"send",body:"<script>alert(1)</script>"})).rejects.toThrow();
 const m=await messageCommand(f.customer.id,c.id,{action:"send",body:"Pickup at the agreed location."}) as {id:string};
 await messageCommand(f.customer.id,c.id,{action:"edit",messageId:m.id,version:0,body:"Pickup at the signed agreement location."});
 await messageCommand(f.customer.id,c.id,{action:"delete",messageId:m.id,version:1});
 expect(await prisma.messageRevision.count({where:{messageId:m.id}})).toBe(3);await expect(prisma.messageRevision.updateMany({where:{messageId:m.id},data:{body:"tamper"}})).rejects.toThrow("immutable");
 expect((await readConversation(f.h.user.id,c.id)).messages[0]).toMatchObject({body:"",version:2});
 expect(await prisma.inboxNotice.count({where:{resourceId:c.id}})).toBe(1);expect(await prisma.outboxMessage.count({where:{deliveryKey:{contains:m.id}}})).toBe(1);
});
it("requires a completed real trip, prevents duplicate reviews, and keeps reviews blind",async()=>{
 const f=await fixture();const data={reservationId:f.r.id,subject:"VEHICLE",rating:5,cleanliness:5,communication:5,accuracy:5,body:"A clean and comfortable trip."};
 await expect(saveTripReview(f.customer.id,data)).rejects.toThrow("completed-trip");await prisma.reservation.update({where:{id:f.r.id},data:{status:"COMPLETED"}});await prisma.trip.update({where:{reservationId:f.r.id},data:{endedAt:new Date()}});
 await saveTripReview(f.customer.id,data);await expect(saveTripReview(f.customer.id,data)).rejects.toThrow();expect((await publicTripReviews("VEHICLE",f.v.id)).count).toBe(0);
 await prisma.tripReview.updateMany({where:{reservationId:f.r.id},data:{publishAfter:new Date(Date.now()-1000)}});expect((await publicTripReviews("VEHICLE",f.v.id)).count).toBe(1);await expect(saveTripReview(f.other.id,data)).rejects.toThrow();
});
it("restricts claims roles, separates internal notes and blocks financial shortcuts",async()=>{
 const f=await fixture();const c=await createServiceCase(f.h.user.id,{kind:"CLAIM",reservationId:f.r.id,category:"DAMAGE",location:"front bumper",title:"Front bumper damage",body:"New damage observed at the return inspection."});
 await expect(readServiceCase(f.support.id,c.id)).rejects.toThrow();await expect(readServiceCase(f.other.id,c.id)).rejects.toThrow();
 await caseCommand(f.agent.id,c.id,{action:"internal",version:0,body:"Private investigation detail"});expect((await readServiceCase(f.customer.id,c.id)).events).toHaveLength(1);expect((await readServiceCase(f.agent.id,c.id)).events).toHaveLength(2);
 await caseCommand(f.customer.id,c.id,{action:"reply",version:1,body:"The damage was present at pickup."});await expect(withReservationLock(f.r.id,tx=>assertFinancialTripStart(tx,f.r.id))).rejects.toThrow("claim or dispute");await expect(withReservationLock(f.r.id,tx=>assertNoUnresolvedFinancialReview(tx,f.r.id))).rejects.toThrow("claim or dispute");
 await expect(createServiceCase(f.h.user.id,{kind:"CLAIM",reservationId:f.r.id,category:"DAMAGE",location:"front bumper",title:"Duplicate report",body:"Duplicate damage observation."})).rejects.toThrow();
});
it("automatically blocks an unsafe vehicle and keeps support tickets private",async()=>{
 const f=await fixture();await createServiceCase(f.customer.id,{kind:"INCIDENT",reservationId:f.r.id,category:"UNSAFE_VEHICLE",title:"Unsafe brakes",body:"Brakes stopped responding safely on the road."});expect(await prisma.vehicle.findUnique({where:{id:f.v.id}})).toMatchObject({status:"MAINTENANCE"});expect(await prisma.vehicleAvailabilityConfig.findUnique({where:{vehicleId:f.v.id}})).toMatchObject({isBookable:false});
 const ticket=await createServiceCase(f.customer.id,{kind:"TICKET",category:"GENERAL",title:"Account help",body:"Please help me with my account."});await expect(readServiceCase(f.other.id,ticket.id)).rejects.toThrow();await expect(readServiceCase(f.agent.id,ticket.id)).rejects.toThrow();await expect(readServiceCase(f.support.id,ticket.id)).resolves.toMatchObject({role:"OPERATOR"});
});
it("legal and financial evidence holds override expired attachment retention",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id});await prisma.conversation.update({where:{id:c.id},data:{retainUntil:new Date(0),legalHold:true}});
 const file=await prisma.collaborationFile.create({data:{conversationId:c.id,uploadedById:f.customer.id,purpose:"MESSAGE",storageKey:"local:"+c.id+".png",mimeType:"image/png",sha256:"test",size:4,scanStatus:"CLEAN",retainUntil:new Date(0)}});expect(await fileHeld(prisma,file.id)).toBe(true);await prisma.conversation.update({where:{id:c.id},data:{legalHold:false,closedAt:new Date()}});expect(await fileHeld(prisma,file.id)).toBe(false);
 await prisma.payment.create({data:{reservationId:f.r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:100}});expect(await fileHeld(prisma,file.id)).toBe(true);
});
it.each(["CLAIM","DISPUTE"] as const)("serializes genuinely simultaneous %s commands on separate PostgreSQL sessions",async kind=>{
 const f=await fixture(),c=await createServiceCase(f.h.user.id,{kind,reservationId:f.r.id,category:"DAMAGE",title:"Concurrent case",body:"This case verifies concurrent updates."});
 const locked=barrier(),release=barrier();const holder=withReservationLock(f.r.id,async()=>{locked.release();await release.wait;});await locked.wait;
 const commands=[caseCommand(f.customer.id,c.id,{action:"reply",version:0,body:"Customer response"},one),caseCommand(f.h.user.id,c.id,{action:"reply",version:0,body:"Host response"},two)];const settled=Promise.allSettled(commands);
 try{let pids:number[]=[];for(let i=0;i<200;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;pids=[...new Set(rows.map(r=>r.pid))];if(pids.length>=2)break;await new Promise(r=>setTimeout(r,10));}expect(pids.length).toBeGreaterThanOrEqual(2);}finally{release.release();await holder;}
 const results=await settled;expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);expect(await prisma.serviceCase.findUnique({where:{id:c.id}})).toMatchObject({version:1});expect(await prisma.serviceCaseEvent.count({where:{caseId:c.id}})).toBe(2);
});
it("HTTP handlers reject anonymous, cross-origin, cross-tenant and unauthorized cron requests",async()=>{
 process.env.AUTH_URL="http://localhost";
 const f=await fixture();const request=(data:unknown,origin="http://localhost")=>new Request("http://localhost/api/community",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(data)});
 session.id="";expect((await POST(request({action:"conversation",reservationId:f.r.id}))).status).toBe(401);session.id=f.customer.id;expect((await POST(request({action:"conversation",reservationId:f.r.id},"https://evil.test"))).status).toBe(403);
 session.id=f.other.id;expect((await POST(request({action:"conversation",reservationId:f.r.id}))).status).toBe(404);session.id=f.customer.id;expect((await POST(request({action:"conversation",reservationId:f.r.id}))).status).toBe(200);
 process.env.CRON_SECRET="community-test-secret";expect((await cron(new Request("http://localhost/api/cron/community",{method:"POST"}))).status).toBe(401);
});

it("private attachment authorization precedes storage access, including revoked uploaders and quarantined files",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id});await prisma.user.update({where:{id:f.other.id},data:{role:"HOST_EMPLOYEE"}});const employee=await prisma.hostEmployee.create({data:{hostId:f.h.hostProfile.id,userId:f.other.id,role:"STAFF"}});
 const file=await prisma.collaborationFile.create({data:{conversationId:c.id,uploadedById:f.other.id,purpose:"MESSAGE",storageKey:"local:"+c.id+"-privacy.png",mimeType:"image/png",sha256:"test",size:4,scanStatus:"CLEAN",retainUntil:new Date(Date.now()+86400000)}});
 privateRead.mockClear();await readCollaborationFile(f.customer.id,file.id);expect(privateRead).toHaveBeenCalledTimes(1);await prisma.hostEmployee.delete({where:{id:employee.id}});privateRead.mockClear();await expect(readCollaborationFile(f.other.id,file.id)).rejects.toThrow();expect(privateRead).not.toHaveBeenCalled();await prisma.collaborationFile.update({where:{id:file.id},data:{scanStatus:"QUARANTINED"}});await expect(readCollaborationFile(f.customer.id,file.id)).rejects.toThrow();expect(privateRead).not.toHaveBeenCalled();
});
it("signed handset STOP revokes SMS consent and rejects forged callbacks",async()=>{
 const f=await fixture(),phone="+15550001111",url="https://example.test/api/community/sms",token="synthetic-token";process.env.TWILIO_AUTH_TOKEN=token;process.env.TWILIO_INBOUND_URL=url;
 await prisma.smsConsent.create({data:{userId:f.customer.id,phone,consentAt:new Date(),source:"HANDSET_CONFIRMED"}});
 const raw="Body=STOP&From=%2B15550001111",signature=createHmac("sha1",token).update(url+"BodySTOPFrom"+phone).digest("base64");const req=(sig:string)=>new Request(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-twilio-signature":sig},body:raw});
 expect((await smsWebhook(req("forged"))).status).toBe(403);expect((await prisma.smsConsent.findUnique({where:{userId:f.customer.id}}))?.stoppedAt).toBeNull();expect((await smsWebhook(req(signature))).status).toBe(200);expect((await prisma.smsConsent.findUnique({where:{userId:f.customer.id}}))?.stoppedAt).not.toBeNull();
});
it.each(["accepted","uncertain"])("durable SMS %s outcome cannot create a duplicate send",async outcome=>{
 const f=await fixture();process.env.TWILIO_ACCOUNT_SID="ACtest";process.env.TWILIO_AUTH_TOKEN="synthetic-token";process.env.TWILIO_FROM_NUMBER="+15550009999";
 await prisma.smsConsent.create({data:{userId:f.customer.id,phone:"+15550001234",consentAt:new Date(),source:"HANDSET_CONFIRMED"}});await prisma.noticePreference.create({data:{userId:f.customer.id,category:"MESSAGE",sms:true}});const notice=await prisma.inboxNotice.create({data:{eventKey:"sms:"+f.r.id,userId:f.customer.id,category:"MESSAGE",resourceType:"RESERVATION",resourceId:f.r.id,title:"Account update"}});
 const send=vi.fn(async()=>{if(outcome==="uncertain")throw new Error("Response lost after provider acceptance");return Response.json({sid:"SMsynthetic",status:"queued"});});vi.stubGlobal("fetch",send);
 try{await deliverNoticeChannels();await deliverNoticeChannels();expect(send).toHaveBeenCalledTimes(1);expect(await prisma.channelDelivery.findUnique({where:{noticeId_channel:{noticeId:notice.id,channel:"SMS"}}})).toMatchObject({state:outcome==="accepted"?"ACCEPTED":"REVIEW",attempts:1});}finally{vi.unstubAllGlobals();}
});

it("case overrides require an isolated one-use step-up code and never clear financial review",async()=>{
 const f=await fixture(),superAdmin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(superAdmin.id);const c=await createServiceCase(f.h.user.id,{kind:"CLAIM",reservationId:f.r.id,category:"DAMAGE",title:"Step-up case",body:"A documented exceptional case decision."});
 const input={action:"override",version:0,body:"Exceptional decision after reviewing all available evidence",confirm:"yes",stepUpCode:"123456"};
 await prisma.authCode.create({data:{email:superAdmin.email,codeHash:await bcrypt.hash("123456",4),purpose:"SIGN_IN",expiresAt:new Date(Date.now()+60000)}});await expect(caseCommand(superAdmin.id,c.id,input)).rejects.toThrow("step-up");await expect(caseCommand(f.agent.id,c.id,input)).rejects.toThrow("step-up");
 await prisma.authCode.create({data:{email:superAdmin.email,codeHash:await bcrypt.hash("123456",4),purpose:"EMERGENCY_OVERRIDE_STEP_UP",expiresAt:new Date(Date.now()+60000)}});await caseCommand(superAdmin.id,c.id,input);expect(await prisma.serviceCase.findUnique({where:{id:c.id}})).toMatchObject({state:"RESOLVED"});expect(await prisma.reservation.findUnique({where:{id:f.r.id}})).toMatchObject({financialDisposition:"REVIEW"});await expect(caseCommand(superAdmin.id,c.id,{...input,version:1})).rejects.toThrow("step-up");expect(await prisma.auditLog.count({where:{actorId:superAdmin.id,action:"case.step_up_override"}})).toBe(1);
});
it("HTTP cron executes projections idempotently and never treats email acceptance as in-app authority",async()=>{
 const f=await fixture();process.env.CRON_SECRET="community-route-test";process.env.TWILIO_ACCOUNT_SID="";process.env.TWILIO_AUTH_TOKEN="";process.env.TWILIO_FROM_NUMBER="";
 const event=await prisma.tripEvent.create({data:{reservationId:f.r.id,actorId:f.h.user.id,type:"IDENTITY_HANDOFF_VERIFIED"}});const key="trip-event:"+event.id;expect(await prisma.inboxNotice.count({where:{eventKey:key}})).toBe(2);
 const request=()=>new Request("http://localhost/api/cron/community",{method:"POST",headers:{authorization:"Bearer community-route-test"}});expect((await cron(request())).status).toBe(200);expect((await cron(request())).status).toBe(200);expect(await prisma.inboxNotice.count({where:{eventKey:key}})).toBe(2);
});

it("a lost private-delete response resumes the exact committed key without reviving the file",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id}),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);await prisma.conversation.update({where:{id:c.id},data:{closedAt:new Date(),retainUntil:new Date(0)}});
 const file=await prisma.collaborationFile.create({data:{conversationId:c.id,uploadedById:f.customer.id,purpose:"MESSAGE",storageKey:"local:"+c.id+"-delete.png",mimeType:"image/png",sha256:"test",size:4,scanStatus:"CLEAN",retainUntil:new Date(0)}}),gone=new Set<string>();privateDelete.mockReset();privateDelete.mockImplementation(async key=>{if(!gone.has(key)){gone.add(key);throw new Error("Response lost after deletion");}});
 await runCollaborationRetention();const job=await prisma.storageDeletionJob.findUniqueOrThrow({where:{fileId:file.id}});expect(job).toMatchObject({state:"PENDING",attempts:1});expect(await prisma.collaborationFile.findUnique({where:{id:file.id}})).toMatchObject({scanStatus:"DELETION_COMMITTED"});await expect(communityAdmin(admin.id,{command:"hold",entity:"FILE",id:file.id,held:"yes",reason:"A later hold cannot revive a committed deletion"})).rejects.toThrow("deletion");
 await prisma.storageDeletionJob.update({where:{id:job.id},data:{nextAttemptAt:new Date(0)}});await runCollaborationRetention();expect(await prisma.storageDeletionJob.findUnique({where:{id:job.id}})).toMatchObject({state:"DONE",attempts:2});expect(gone.size).toBe(1);expect(privateDelete.mock.calls.map(c=>c[0])).toEqual([file.storageKey,file.storageKey]);privateDelete.mockReset();
});
it("a concurrent legal hold wins before storage deletion at a real PostgreSQL lock barrier",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id});await prisma.conversation.update({where:{id:c.id},data:{closedAt:new Date(),retainUntil:new Date(0)}});const file=await prisma.collaborationFile.create({data:{conversationId:c.id,uploadedById:f.customer.id,purpose:"MESSAGE",storageKey:"local:"+c.id+"-held.png",mimeType:"image/png",sha256:"test",size:4,scanStatus:"CLEAN",retainUntil:new Date(0)}});
 const locked=barrier(),release=barrier();privateDelete.mockReset();const hold=one.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${c.id} FOR UPDATE`;await tx.conversation.update({where:{id:c.id},data:{legalHold:true}});locked.release();await release.wait;});await locked.wait;const work=runCollaborationRetention();
 try{let waiting=false;for(let i=0;i<200;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT "id" FROM "Conversation"%'`;if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);}finally{release.release();await hold;}
 await work;expect(privateDelete).not.toHaveBeenCalled();expect(await prisma.collaborationFile.findUnique({where:{id:file.id}})).toMatchObject({deletedAt:null,scanStatus:"CLEAN"});
});

it("references only accepted evidence from the same trip and leaves original photos immutable",async()=>{
 const f=await fixture(),g=await fixture();
 const report=await prisma.conditionReport.create({data:{reservationId:f.r.id,phase:"PRE_TRIP",submittedById:f.h.user.id,submittedByRole:"HOST",acceptedAt:new Date(),mileage:1000,fuelLevel:90,photos:{create:{category:"EXTERIOR",storageKey:"local:original-private-evidence"}}},include:{photos:true}});
 const photo=report.photos[0],snapshot=JSON.stringify(photo);
 await expect(createServiceCase(g.h.user.id,{kind:"CLAIM",reservationId:g.r.id,category:"DAMAGE",title:"Wrong trip evidence",body:"This evidence must not cross tenant boundaries.",originalPhotoIds:[photo.id]})).rejects.toThrow("Evidence must belong");
 const c=await createServiceCase(f.h.user.id,{kind:"CLAIM",reservationId:f.r.id,category:"DAMAGE",title:"Original evidence claim",body:"Compare accepted immutable trip evidence.",originalPhotoIds:[photo.id]});
 await caseCommand(f.h.user.id,c.id,{action:"transition",version:0,state:"EVIDENCE_SUBMITTED",body:"Submitted accepted original trip evidence."});
 expect(JSON.stringify(await prisma.conditionPhoto.findUnique({where:{id:photo.id}}))).toBe(snapshot);
 expect((await readServiceCase(f.customer.id,c.id)).originalPhotos.map(p=>p.id)).toContain(photo.id);
 expect(await prisma.collaborationFile.count({where:{caseId:c.id}})).toBe(0);
});
it("restricts privacy decisions and deletion retries to super admins without clearing retention holds",async()=>{
 const f=await fixture();const request=await prisma.privacyDeletion.create({data:{userId:f.customer.id}});
 await expect(communityAdmin(f.support.id,{command:"privacyReview",id:request.id,state:"SCHEDULED_RETENTION",reason:"Reviewed the record retention requirements."})).rejects.toThrow();
 await prisma.user.update({where:{id:f.agent.id},data:{role:"SUPER_ADMIN"}});
 await communityAdmin(f.agent.id,{command:"privacyReview",id:request.id,state:"RETAINED_LEGAL_REVIEW",reason:"Financial and agreement retention requires review."});
 expect(await prisma.privacyDeletion.findUnique({where:{id:request.id}})).toMatchObject({state:"RETAINED_LEGAL_REVIEW",reviewedAt:expect.any(Date)});
 expect(await prisma.auditLog.count({where:{entityId:request.id,action:"privacy.review"}})).toBe(1);
});

it("does not let a full batch of held files starve a later eligible deletion",async()=>{
 const f=await fixture();const c=await openConversation(f.customer.id,{vehicleId:f.v.id});const past=new Date(Date.now()-86400000);
 await prisma.conversation.update({where:{id:c.id},data:{retainUntil:past}});
 const common={conversationId:c.id,uploadedById:f.customer.id,purpose:"MESSAGE",mimeType:"image/png",sha256:"synthetic-hash",size:20,scanStatus:"CLEAN",retainUntil:past};
 await prisma.collaborationFile.createMany({data:Array.from({length:101},(_,i)=>({...common,storageKey:"local:held-"+c.id+"-"+i,legalHold:true}))});
 const eligible=await prisma.collaborationFile.create({data:{...common,storageKey:"local:eligible-"+c.id}});
 privateDelete.mockClear();await runCollaborationRetention();
 expect(privateDelete).toHaveBeenCalledWith(eligible.storageKey);
 expect(await prisma.storageDeletionJob.findUnique({where:{fileId:eligible.id}})).toMatchObject({state:"DONE"});
 expect(await prisma.collaborationFile.count({where:{conversationId:c.id,legalHold:true,deletedAt:null}})).toBe(101);
});

it("a concurrent uncertain financial intent prevents deletion before any Payment projection exists",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id});await prisma.conversation.update({where:{id:c.id},data:{closedAt:new Date(),retainUntil:new Date(0)}});
 const file=await prisma.collaborationFile.create({data:{conversationId:c.id,uploadedById:f.customer.id,purpose:"MESSAGE",storageKey:"local:"+c.id+"-financial.png",mimeType:"image/png",sha256:"test",size:4,scanStatus:"CLEAN",retainUntil:new Date(0)}});
 const locked=barrier(),release=barrier();privateDelete.mockReset();
 const intent=withReservationLock(f.r.id,async tx=>{await tx.financialOperation.create({data:{reservationId:f.r.id,key:"retention-test:"+f.r.id,kind:"RENTAL",fingerprint:"immutable-test-fingerprint",payload:{},state:"UNKNOWN"}});locked.release();await release.wait;},one);
 await locked.wait;const work=runCollaborationRetention();
 try{let waiting=false;for(let i=0;i<200;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);}finally{release.release();await intent;}
 await work;expect(await prisma.payment.count({where:{reservationId:f.r.id}})).toBe(0);expect(await fileHeld(prisma,file.id)).toBe(true);expect(privateDelete).not.toHaveBeenCalled();expect(await prisma.collaborationFile.findUnique({where:{id:file.id}})).toMatchObject({deletedAt:null});
});

it("notification HTTP redirects preserve the browser origin and recheck current target access",async()=>{
 const f=await fixture(),c=await openConversation(f.customer.id,{reservationId:f.r.id});await messageCommand(f.h.user.id,c.id,{action:"send",body:"A private update for your trip."});const n=await prisma.inboxNotice.findFirstOrThrow({where:{userId:f.customer.id,resourceId:c.id}});
 session.id=f.customer.id;const response=await openNotice(new Request("http://internal-server/api/community/notices/"+n.id),{params:Promise.resolve({id:n.id})});expect(response.status).toBe(303);expect(response.headers.get("location")).toBe("/connect/conversations/"+c.id);expect(response.headers.get("cache-control")).toContain("no-store");
 session.id=f.other.id;expect((await openNotice(new Request("http://internal-server/api/community/notices/"+n.id),{params:Promise.resolve({id:n.id})})).status).toBe(404);session.id="";
});

it("notification preferences match legacy trip events and plan only the selected channel",async()=>{
 const f=await fixture();session.id=f.customer.id;process.env.AUTH_URL="http://localhost";
 const response=await POST(new Request("http://localhost/api/community",{method:"POST",headers:{origin:"http://localhost","content-type":"application/json"},body:JSON.stringify({action:"preference",category:"TRIP",email:"off",sms:"on"})}));expect(response.status).toBe(200);
 await prisma.$transaction(tx=>enqueueOutboxNotification(tx,{userId:f.customer.id,reservationId:f.r.id,type:"PICKUP_REMINDER"},"preference-test:"+f.r.id));
 const n=await prisma.inboxNotice.findFirstOrThrow({where:{userId:f.customer.id,resourceId:f.r.id,category:"TRIP"}});expect(n.required).toBe(true);await projectTransactionalNotices();expect(await prisma.outboxMessage.count({where:{deliveryKey:"community:"+f.customer.id+":"+n.eventKey}})).toBe(0);
 await deliverNoticeChannels();expect(await prisma.channelDelivery.findUnique({where:{noticeId_channel:{noticeId:n.id,channel:"SMS"}}})).toMatchObject({state:"READY",attempts:0});expect(await prisma.channelDelivery.count({where:{noticeId:n.id,channel:"PUSH"}})).toBe(0);session.id="";
});
