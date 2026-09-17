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
const privateRead=vi.hoisted(()=>vi.fn(async()=>({buffer:Buffer.from("private evidence")})));
vi.mock("@/lib/storage",async original=>({...await original<typeof import("@/lib/storage")>(),readPrivateDocument:privateRead}));
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
 await prisma.inboxNotice.deleteMany({where:{userId:{in:users}}});await prisma.communityReport.deleteMany({where:{actorId:{in:users}}});
 for(const userId of users)await prisma.outboxMessage.deleteMany({where:{payload:{path:["userId"],equals:userId}}});
 await cleanupReservationsForVehicles(vehicles);await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.hostEmployee.deleteMany({where:{hostId:{in:hosts}}});await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.hostProfile.deleteMany({where:{id:{in:hosts}}});await prisma.user.deleteMany({where:{id:{in:users}}});await one.$disconnect();await two.$disconnect();await prisma.$disconnect();
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
