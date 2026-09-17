import { afterAll, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma,createTestHost,createTestCustomer,createTestVehicle,createTestReservation,cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { withReservationLock } from "@/lib/financial-locks";
import { runCollaborationRetention } from "@/lib/collaboration-retention";
import { createServiceCase,caseCommand } from "@/lib/service-cases";
import { communityAdmin } from "@/lib/community-admin";
const session=vi.hoisted(()=>({id:""}));
vi.mock("@/auth",()=>({auth:async()=>session.id ? {user:{id:session.id}} : null}));
import { POST } from "@/app/api/community/route";
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
 await cleanupReservationsForVehicles(vehicles);await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.hostEmployee.deleteMany({where:{hostId:{in:hosts}}});await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.vehicleOwner.deleteMany({where:{hostId:{in:hosts}}});await prisma.hostProfile.deleteMany({where:{id:{in:hosts}}});await prisma.authCode.deleteMany({where:{email:{in:(await prisma.user.findMany({where:{id:{in:users}},select:{email:true}})).map(u=>u.email)}}});await prisma.user.deleteMany({where:{id:{in:users}}});await one.$disconnect();await two.$disconnect();await prisma.$disconnect();
});
async function fixture(status:"ACTIVE"|"COMPLETED"="ACTIVE"){
 const h=await createTestHost(),customer=await createTestCustomer(),other=await createTestCustomer(),agent=await createTestCustomer({role:"CLAIMS_AGENT"}),support=await createTestCustomer({role:"SUPPORT_AGENT"});users.push(h.user.id,customer.id,other.id,agent.id,support.id);hosts.push(h.hostProfile.id);
 const v=await createTestVehicle({hostId:h.hostProfile.id,listingApproval:"APPROVED"});vehicles.push(v.id);
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date(Date.now()-86400000),returnAt:new Date(),status});
 await prisma.trip.create({data:{reservationId:r.id,startedAt:new Date(Date.now()-86400000),...(status==="COMPLETED"?{endedAt:new Date()}: {})}});
 return {h,customer,other,agent,support,v,r};
}

async function review(f:Awaited<ReturnType<typeof fixture>>) {
 const r=await prisma.tripReview.create({data:{reservationId:f.r.id,reviewerId:f.customer.id,subject:"VEHICLE",subjectId:f.v.id,rating:4,categories:{accuracy:4,communication:5},body:"Original retained review evidence",publishAfter:new Date(0),retainUntil:new Date(0)}});
 await prisma.reviewHistory.create({data:{reviewId:r.id,actorId:f.customer.id,action:"CREATE",reason:"Author submission",snapshot:{body:r.body,categories:r.categories,rating:4}}});
 await prisma.reviewHistory.create({data:{reviewId:r.id,actorId:f.agent.id,action:"HIDE",reason:"Moderation evidence",snapshot:{hidden:false}}});
 return r;
}
async function history(id:string){return prisma.reviewHistory.findMany({where:{reviewId:id},orderBy:{id:"asc"}});}
async function caseRecord(f:Awaited<ReturnType<typeof fixture>>,kind:string,extra={}) {
 return prisma.serviceCase.create({data:{kind,reservationId:f.r.id,vehicleId:f.v.id,openedById:f.customer.id,category:"GENERAL",title:"Retained evidence",details:{body:"Case evidence"},dueAt:new Date(),retainUntil:new Date(0),...extra}});
}
it.each(["CLAIM","DISPUTE","APPEAL","LEGAL","SECURITY","FINANCIAL_CASE","RECONCILIATION","UNKNOWN_OPERATION","PAYMENT","DEPOSIT","AGREEMENT","INCIDENT","TICKET","PRIVACY","CONVERSATION_HOLD","REVIEW_HOLD"])("retention preserves expired review and complete history for %s",async kind=>{
 const f=await fixture("COMPLETED"),r=await review(f),before=await history(r.id);
 if (["CLAIM","DISPUTE","INCIDENT","TICKET"].includes(kind)) await caseRecord(f,kind);
 if (kind==="APPEAL") await caseRecord(f,"DISPUTE",{state:"UNDER_REVIEW"});
 if (["LEGAL","SECURITY"].includes(kind)) await caseRecord(f,"TICKET",{state:"CLOSED",legalHold:kind==="LEGAL",securityHold:kind==="SECURITY"});
 if (kind==="FINANCIAL_CASE") await prisma.financialCase.create({data:{sourceKey:r.id,reservationId:f.r.id,customerId:f.customer.id,kind:"RENTAL",reason:"Unresolved reconciliation"}});
 if (kind==="RECONCILIATION") await prisma.paymentReconciliation.create({data:{reservationId:f.r.id,reason:"PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED"}});
 if (kind==="UNKNOWN_OPERATION") await prisma.financialOperation.create({data:{reservationId:f.r.id,key:r.id,kind:"RENTAL",state:"UNKNOWN",fingerprint:r.id,payload:{}}});
 if (kind==="PAYMENT") await prisma.payment.create({data:{reservationId:f.r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:100}});
 if (kind==="DEPOSIT") await prisma.securityDeposit.create({data:{reservationId:f.r.id,amountCents:100}});
 if (kind==="AGREEMENT") await prisma.agreementAcceptance.create({data:{reservationId:f.r.id,type:"RENTAL_AGREEMENT",signedByUserId:f.customer.id,signerName:"Test signer",contentSnapshot:"Signed evidence",contentHash:r.id,documentVersion:"test"}});
 if (kind==="PRIVACY") await prisma.privacyDeletion.create({data:{userId:f.customer.id,state:"RETAINED_LEGAL_REVIEW"}});
 if (kind==="CONVERSATION_HOLD") await prisma.conversation.create({data:{reservationId:f.r.id,vehicleId:f.v.id,customerId:f.customer.id,legalHold:true,retainUntil:new Date(0)}});
 if (kind==="REVIEW_HOLD") await prisma.tripReview.update({where:{id:r.id},data:{legalHold:true}});
 await runCollaborationRetention();
 expect(await prisma.tripReview.findUnique({where:{id:r.id}})).toMatchObject({body:r.body,categories:r.categories,rating:r.rating});
 expect(await history(r.id)).toEqual(before);
});

it("retention filters more than two batches of held reviews before LIMIT and preserves audit after release",async()=>{
 const held=await fixture("COMPLETED"),eligible=await fixture("COMPLETED");
 const hold=await caseRecord(held,"TICKET",{state:"CLOSED",legalHold:true});
 const first=await review(held),before=await history(first.id);
 for(let i=0;i<101;i++){
  const author=await createTestCustomer();users.push(author.id);
  await prisma.tripReview.create({data:{...first,id:undefined,reviewerId:author.id,categories:{accuracy:4,communication:5}}});
 }
 const last=await review(eligible),lastHistory=await history(last.id);
 await runCollaborationRetention();
 expect(await prisma.tripReview.count({where:{reservationId:held.r.id,body:first.body}})).toBe(102);
 expect(await prisma.tripReview.findUnique({where:{id:last.id}})).toMatchObject({body:"",categories:{},hidden:true});
 expect(await history(last.id)).toEqual(lastHistory);
 const admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
 await communityAdmin(admin.id,{command:"hold",entity:"CASE",id:hold.id,held:"no",reason:"Expired removable hold resolved"});
 await runCollaborationRetention();await runCollaborationRetention();await runCollaborationRetention();
 expect(await prisma.tripReview.count({where:{reservationId:held.r.id,body:{not:""}}})).toBe(0);
 expect(await history(first.id)).toEqual(before);
 expect(await prisma.auditLog.count({where:{entityId:first.id,action:"retention.review_content.purged"}})).toBe(1);
});

async function waitForBlockedConnections(min:number) {
 let rows:Array<{pid:number}>=[];
 for(let i=0;i<300;i++){
  rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT financial_guard_xact%'`;
  if(new Set(rows.map(r=>r.pid)).size>=min) return rows.map(r=>r.pid);
  await new Promise(r=>setTimeout(r,10));
 }
 throw new Error(`Expected ${min} distinct blocked PostgreSQL sessions; observed ${rows.length}`);
}
it.each(["financial intent","claim"])("retention rechecks after a concurrent %s commits on another PostgreSQL connection",async kind=>{
 const f=await fixture("COMPLETED"),r=await review(f),before=await history(r.id),locked=barrier(),release=barrier();let holderPid=0;
 const writer=withReservationLock(f.r.id,async tx=>{
  holderPid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;
  if(kind==="financial intent") await tx.financialOperation.create({data:{reservationId:f.r.id,key:r.id,kind:"RENTAL",state:"UNKNOWN",fingerprint:r.id,payload:{}}});
  else await tx.serviceCase.create({data:{kind:"CLAIM",reservationId:f.r.id,vehicleId:f.v.id,openedById:f.h.user.id,category:"DAMAGE",title:"Concurrent claim",details:{},dueAt:new Date(),retainUntil:new Date(0)}});
  locked.release();await release.wait;
 },one);await locked.wait;
 const worker=runCollaborationRetention();
 try{const pids=await waitForBlockedConnections(1);expect(pids).not.toContain(holderPid);}finally{release.release();await writer;}
 await worker;expect(await prisma.tripReview.findUnique({where:{id:r.id}})).toMatchObject({body:r.body,categories:r.categories});expect(await history(r.id)).toEqual(before);
});

async function stepCode(email:string) {return prisma.authCode.create({data:{email,purpose:"EMERGENCY_OVERRIDE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});}
const override={action:"override",version:1,body:"Exceptional decision with complete independent evidence",confirm:"yes",stepUpCode:"123456"};
it.each(["customer","host","vehicle owner","employee","former employee","evidence submitter","original evidence submitter"])("HTTP override rejects conflicted SUPER_ADMIN %s without consuming code or changing decision",async conflict=>{
 const f=await fixture();const c=await createServiceCase(f.h.user.id,{kind:"CLAIM",reservationId:f.r.id,category:"DAMAGE",title:"Conflict policy",body:"Evidence for conflict authorization tests"});
 await caseCommand(f.agent.id,c.id,{action:"assign",assigneeId:f.agent.id,version:0,body:"Independent ordinary agent"});
 const actor=conflict==="customer"?f.customer:conflict==="host"?f.h.user:f.other;
 if(conflict==="vehicle owner") {const owner=await prisma.vehicleOwner.create({data:{name:"Independent title owner",email:actor.email,hostId:f.h.hostProfile.id}});await prisma.vehicle.update({where:{id:f.v.id},data:{ownerId:owner.id}});}
 if(conflict.includes("employee")){const employee=await prisma.hostEmployee.create({data:{hostId:f.h.hostProfile.id,userId:actor.id}});if(conflict==="former employee") await prisma.hostEmployee.delete({where:{id:employee.id}});}
 if(conflict==="evidence submitter") await prisma.collaborationFile.create({data:{caseId:c.id,uploadedById:actor.id,purpose:"DAMAGE",storageKey:"local:"+c.id,mimeType:"image/png",sha256:"test",size:1,scanStatus:"CLEAN",retainUntil:new Date(Date.now()+86400000)}});
 if(conflict==="original evidence submitter") await prisma.conditionReport.create({data:{reservationId:f.r.id,submittedById:actor.id,submittedByRole:"HOST",phase:"PRE_TRIP",mileage:100,fuelLevel:100}});
 await prisma.user.update({where:{id:actor.id},data:{role:"SUPER_ADMIN"}});const code=await stepCode(actor.email),before=await prisma.serviceCase.findUnique({where:{id:c.id}}),events=await prisma.serviceCaseEvent.findMany({where:{caseId:c.id}});
 session.id=actor.id;process.env.AUTH_URL="http://localhost";
 const response=await POST(new Request("http://localhost/api/community",{method:"POST",headers:{origin:"http://localhost","content-type":"application/json"},body:JSON.stringify({...override,action:"caseCommand",command:"override",id:c.id})}));
 expect(response.status).toBe(403);expect(await prisma.serviceCase.findUnique({where:{id:c.id}})).toEqual(before);expect(await prisma.serviceCaseEvent.findMany({where:{caseId:c.id}})).toEqual(events);
 expect(await prisma.authCode.findUnique({where:{id:code.id}})).toMatchObject({consumedAt:null,attempts:0});expect(await prisma.auditLog.count({where:{actorId:actor.id,action:"case.step_up_override"}})).toBe(0);
 await expect(caseCommand(actor.id,c.id,{action:"takeover",version:1,body:"Attempting to take over my own case"})).rejects.toThrow();
});

it("independent SUPER_ADMIN must explicitly take over, notify prior assignee, then consume a purpose-specific code",async()=>{
 const f=await fixture(),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
 const c=await createServiceCase(f.customer.id,{kind:"DISPUTE",reservationId:f.r.id,category:"REFUND",title:"Independent review",body:"Evidence for independent takeover"});
 await caseCommand(f.agent.id,c.id,{action:"assign",version:0,assigneeId:f.agent.id,body:"Independent agent assigned"});const code=await stepCode(admin.email);
 await expect(caseCommand(admin.id,c.id,override)).rejects.toThrow("take over");
 await expect(caseCommand(admin.id,c.id,{action:"assign",version:1,assigneeId:admin.id,body:"Silent replacement attempt"})).rejects.toThrow("takeover");
 await caseCommand(admin.id,c.id,{action:"takeover",version:1,body:"Urgent independent reassignment with reason"});
 expect(await prisma.auditLog.findFirst({where:{entityId:c.id,action:"case.assignment.takeover"}})).toMatchObject({metadata:{previousAssigneeId:f.agent.id,newAssigneeId:admin.id}});
 expect(await prisma.inboxNotice.count({where:{userId:f.agent.id,eventKey:`takeover:${c.id}:2`}})).toBe(1);
 await caseCommand(admin.id,c.id,{...override,version:2});
 expect(await prisma.authCode.findUnique({where:{id:code.id}})).toMatchObject({attempts:1,consumedAt:expect.any(Date)});
 expect(await prisma.serviceCase.findUnique({where:{id:c.id}})).toMatchObject({state:"DECIDED",assignedToId:admin.id,version:3});
 expect(await prisma.reservation.findUnique({where:{id:f.r.id}})).toMatchObject({financialDisposition:"REVIEW"});
 expect(await prisma.financialOperation.count({where:{reservationId:f.r.id}})).toBe(0);
});

it("ordinary decision and emergency takeover race on separate connections with one version winner",async()=>{
 const f=await fixture(),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
 const c=await createServiceCase(f.customer.id,{kind:"DISPUTE",reservationId:f.r.id,category:"REFUND",title:"Concurrent decision",body:"Evidence for concurrent adjudication"});
 await caseCommand(f.agent.id,c.id,{action:"assign",version:0,assigneeId:f.agent.id,body:"Independent agent assigned"});
 await prisma.serviceCase.update({where:{id:c.id},data:{state:"UNDER_REVIEW"}});
 const locked=barrier(),release=barrier(),holder=withReservationLock(f.r.id,async()=>{locked.release();await release.wait;});await locked.wait;
 const settled=Promise.allSettled([caseCommand(f.agent.id,c.id,{action:"transition",state:"DECIDED",version:1,body:"Ordinary independent decision"},one),caseCommand(admin.id,c.id,{action:"takeover",version:1,body:"Explicit emergency takeover reason"},two)]);
 try{expect(new Set(await waitForBlockedConnections(2)).size).toBeGreaterThanOrEqual(2);}finally{release.release();await holder;}
 const results=await settled;expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
 const current=await prisma.serviceCase.findUniqueOrThrow({where:{id:c.id}});expect(current.version).toBe(2);expect(await prisma.serviceCaseEvent.count({where:{caseId:c.id}})).toBe(3);
 if(current.assignedToId===admin.id){await stepCode(admin.email);await caseCommand(admin.id,c.id,{...override,version:2});}else expect(current.state).toBe("DECIDED");
});

it("reservation holds preserve messages, case evidence, attachment intents and notification provider evidence",async()=>{
 const f=await fixture("COMPLETED"),r=await review(f);
 const c=await prisma.conversation.create({data:{reservationId:f.r.id,customerId:f.customer.id,vehicleId:f.v.id,closedAt:new Date(0),retainUntil:new Date(0)}});
 const m=await prisma.conversationMessage.create({data:{conversationId:c.id,senderId:f.customer.id,body:"Retained message"}});
 await prisma.messageRevision.create({data:{messageId:m.id,actorId:f.customer.id,version:0,action:"SEND",body:m.body}});
 const ticket=await caseRecord(f,"TICKET",{state:"CLOSED"});
 const event=await prisma.serviceCaseEvent.create({data:{caseId:ticket.id,actorId:f.customer.id,action:"OPEN",fromState:"",toState:"REPORTED",body:"Retained incident and support evidence",version:0}});
 const file=await prisma.collaborationFile.create({data:{caseId:ticket.id,uploadedById:f.customer.id,purpose:"SUPPORT",storageKey:"local:"+r.id,mimeType:"image/png",sha256:"test",size:1,scanStatus:"CLEAN",retainUntil:new Date(0)}});
 const notice=await prisma.inboxNotice.create({data:{eventKey:r.id,userId:f.customer.id,category:"TICKET",resourceType:"CASE",resourceId:ticket.id,title:"Case evidence"}});
 const delivery=await prisma.channelDelivery.create({data:{noticeId:notice.id,userId:f.customer.id,channel:"SMS",state:"ACCEPTED",providerId:"SM-evidence",createdAt:new Date(0)}});
 const admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
 await communityAdmin(admin.id,{command:"hold",entity:"REVIEW",id:r.id,held:"yes",reason:"Reservation evidence under legal hold"});
 await runCollaborationRetention();
 expect(await prisma.conversationMessage.findUnique({where:{id:m.id}})).toMatchObject({body:m.body});
 expect(await prisma.messageRevision.count({where:{messageId:m.id}})).toBe(1);
 expect(await prisma.serviceCaseEvent.findUnique({where:{id:event.id}})).toEqual(event);
 expect(await prisma.collaborationFile.findUnique({where:{id:file.id}})).toMatchObject({deletedAt:null,scanStatus:"CLEAN"});
 expect(await prisma.storageDeletionJob.count({where:{fileId:file.id}})).toBe(0);
 expect(await prisma.channelDelivery.findUnique({where:{id:delivery.id}})).toMatchObject({state:"ACCEPTED",providerId:"SM-evidence"});
});

it("a review hold writer uses the same reservation lock as the actual retention worker",async()=>{
 const f=await fixture("COMPLETED"),r=await review(f),before=await history(r.id),admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
 // Block the review row, then let the hold writer own the reservation while it
 // waits for that row. Retention selects the still-unheld review and must wait.
 const locked=barrier(),release=barrier();
 const blocker=one.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "TripReview" WHERE id=${r.id} FOR UPDATE`;locked.release();await release.wait;},{timeout:15000});await locked.wait;
 const holding=communityAdmin(admin.id,{command:"hold",entity:"REVIEW",id:r.id,held:"yes",reason:"Concurrent legal preservation hold"});
 try{
  let waiting=false;for(let i=0;i<300;i++){const rows=await prisma.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM "TripReview"%'`;if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
  const worker=runCollaborationRetention();await waitForBlockedConnections(1);release.release();await blocker;await holding;await worker;
 }finally{release.release();await blocker;}
 expect(await prisma.tripReview.findUnique({where:{id:r.id}})).toMatchObject({body:r.body,categories:r.categories,legalHold:true});expect(await history(r.id)).toEqual(before);
});
