import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient, type ReservationStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";
import { barrier } from "./helpers/barrier";
import { withReservationLock, assertFinancialTripStart } from "@/lib/financial-locks";
import { getOrCreateRefundOperation, executeRefundOperation } from "@/lib/refund-operations";
import { attemptDepositAuthorization } from "@/lib/deposit-authorization";
import { handlePaymentIntentSucceeded } from "@/lib/stripe-webhook-handlers";
import { createOrRefreshHold } from "@/lib/checkout-hold";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { dueOperations, recoverDeposits } from "@/lib/financial-workers";
import { resolveFinancialCase } from "@/lib/financial-case-resolution";
const provider=vi.hoisted(()=>({refunds:{create:vi.fn(),retrieve:vi.fn(),list:vi.fn()},paymentIntents:{create:vi.fn(),retrieve:vi.fn(),cancel:vi.fn()}}));
vi.mock("@/lib/stripe",()=>({stripe:provider}));
const vehicles:string[]=[],users:string[]=[];
const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("connection_limit","1");
const other=new PrismaClient({datasources:{db:{url:url.toString()}}});
afterEach(()=>{vi.restoreAllMocks();for(const group of Object.values(provider))for(const fn of Object.values(group))fn.mockReset()});
afterAll(async()=>{await cleanupReservationsForVehicles(vehicles);await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.user.deleteMany({where:{id:{in:users}}});await other.$disconnect();await prisma.$disconnect()});
async function fixture(status:ReservationStatus="CONFIRMED",depositCents=0){
 const v=await createTestVehicle({securityDepositCents:depositCents}),u=await createTestCustomer();vehicles.push(v.id);users.push(u.id);
 const r=await createTestReservation({vehicleId:v.id,customerId:u.id,pickupAt:new Date("2037-04-01T15:00Z"),returnAt:new Date("2037-04-04T15:00Z"),status,depositCents});
 const p=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:15000,stripePaymentIntentId:"pi_"+r.id}});
 if(depositCents)await prisma.securityDeposit.create({data:{reservationId:r.id,amountCents:depositCents}});
 return {r,p,u,v};
}
function capture(id:string){return {id,status:"requires_capture",amount:30000,amount_capturable:30000,currency:"usd",created:1,latest_charge:{created:1,payment_method_details:{card:{capture_before:Math.floor(Date.now()/1000)+3600}}}}}
describe("Batch 1D durable boundaries",()=>{
 it.each(["ACTIVE","RETURN_IN_PROGRESS","COMPLETED","DISPUTED","UNDER_CLAIM_REVIEW"] as ReservationStatus[])("rejects ordinary refunds of %s before persisting intent",async status=>{
  const {r,p}=await fixture(status);await expect(getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:15000,idempotencyKey:randomUUID()})).rejects.toThrow();
  expect(await prisma.refund.count({where:{reservationId:r.id}})).toBe(0);expect(await prisma.financialOperation.count({where:{reservationId:r.id}})).toBe(0);expect(provider.refunds.create).not.toHaveBeenCalled();
 });
 it.each([15000,1000])("releases inventory only after durable full refund (%i cents), never on payment replay",async amount=>{
  const {r,p,u}=await fixture();const refund=await getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:amount,idempotencyKey:randomUUID()});
  const hold=()=>createOrRefreshHold({customerId:u.id,vehicleId:r.vehicleId,pickupAt:r.pickupAt,returnAt:r.returnAt,extraIds:[]});
  await expect(hold()).rejects.toThrow();provider.refunds.create.mockResolvedValue({id:"re_"+r.id,status:"pending"});await executeRefundOperation(refund.id,p.stripePaymentIntentId);await expect(hold()).rejects.toThrow();
  provider.refunds.retrieve.mockResolvedValue({id:"re_"+r.id,status:"succeeded"});await executeRefundOperation(refund.id,p.stripePaymentIntentId);
  await handlePaymentIntentSucceeded({id:p.stripePaymentIntentId,metadata:{}} as never);
  if(amount===15000){expect((await prisma.reservation.findUniqueOrThrow({where:{id:r.id}})).financialDisposition).toBe("TERMINATED");expect((await hold()).id).not.toBe(r.id)}else await expect(hold()).rejects.toThrow();
 });
 it("commits a generation-specific release when provider discovery races cancellation, surviving a crash before dispatcher continuation",async()=>{
  const {r}=await fixture("CONFIRMED",30000),entered=barrier(),release=barrier();const intent=capture("pi_dep_"+r.id);
  provider.paymentIntents.create.mockImplementation(async()=>{entered.release();await release.wait;return intent});
  const snapshot=await prisma.reservation.findUniqueOrThrow({where:{id:r.id},include:{deposit:true}});
  const running=attemptDepositAuthorization(snapshot,{payment_method:"pm_x",customer:"cus_x"} as never);
  await entered.wait;
  await withReservationLock(r.id,tx=>transitionReservation(tx,{id:r.id,from:"CONFIRMED",to:"CANCELLED_BY_CUSTOMER"}),other);
  release.release();await running;
  // No live-handler compensation is invoked. The process can disappear now.
  const obligation=await prisma.financialOperation.findUniqueOrThrow({where:{key:"deposit-release:"+intent.id}});
  expect(obligation.state).toBe("READY");expect(provider.paymentIntents.cancel).not.toHaveBeenCalled();
  provider.paymentIntents.retrieve.mockResolvedValue(intent);provider.paymentIntents.cancel.mockResolvedValue({...intent,status:"canceled"});
  await recoverDeposits();expect(provider.paymentIntents.cancel).toHaveBeenCalledWith(intent.id,{},expect.anything());
  expect((await prisma.financialOperation.findUniqueOrThrow({where:{id:obligation.id}})).state).toBe("OBSERVED");
 });
 it("blocks trip start on mismatched, older and quarantined deposit generations",async()=>{
  const {r}=await fixture("READY_TO_START",30000);const intent=capture("pi_gen_"+r.id);provider.paymentIntents.create.mockResolvedValue(intent);
  await attemptDepositAuthorization(await prisma.reservation.findUniqueOrThrow({where:{id:r.id},include:{deposit:true}}),{payment_method:"pm",customer:"cus"} as never);
  await expect(withReservationLock(r.id,tx=>assertFinancialTripStart(tx,r.id))).resolves.toBeUndefined();
  for(const patch of [{generation:99},{generation:1,legacyUncertain:true},{generation:1,legacyUncertain:false,stripePaymentIntentId:"pi_wrong"},{stripePaymentIntentId:intent.id,capturableAmountCents:1}]){
   await prisma.securityDeposit.update({where:{reservationId:r.id},data:patch});await expect(withReservationLock(r.id,tx=>assertFinancialTripStart(tx,r.id))).rejects.toThrow();
  }
 });
 it("keeps uncertain FAILED refund balance reserved, verifies adoption and audits settlement authorization",async()=>{
  const {r,p}=await fixture();const admin=await createTestCustomer({role:"SUPER_ADMIN"});users.push(admin.id);
  const f=await prisma.refund.create({data:{reservationId:r.id,paymentId:p.id,amountCents:14000,status:"FAILED",legacyUncertain:true,idempotencyKey:randomUUID()}});
  await expect(getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:1001,idempotencyKey:randomUUID()})).rejects.toThrow("balance");
  const c=await prisma.financialCase.create({data:{sourceKey:"refund:"+f.id,refundId:f.id,reservationId:r.id,customerId:r.customerId,kind:"REFUND",amountCents:14000,originalKey:f.idempotencyKey,reason:"Legacy ambiguous result"}});
  await prisma.reservation.update({where:{id:r.id},data:{financialDisposition:"REVIEW"}});
  provider.refunds.retrieve.mockResolvedValue({id:"re_prior",status:"succeeded",amount:14000,currency:"usd",payment_intent:p.stripePaymentIntentId});
  await resolveFinancialCase(admin,{caseId:c.id,action:"ADOPT",providerId:"re_prior",reason:"Matched provider ledger and original rental identity"});
  expect(provider.refunds.create).not.toHaveBeenCalled();expect((await prisma.refund.findUniqueOrThrow({where:{id:f.id}})).status).toBe("SUCCEEDED");
  await resolveFinancialCase(admin,{caseId:c.id,action:"AUTHORIZE_SETTLEMENT",reason:"Cancel unfulfilled pre-trip rental and refund remainder"});
  expect(await prisma.refund.count({where:{reservationId:r.id,status:"PENDING",amountCents:1000}})).toBe(1);
  expect(await prisma.auditLog.count({where:{entityId:c.id}})).toBe(2);
 });
 it("requires active administrator authority, a reason and provider failure evidence",async()=>{
  const {r,u}=await fixture();const c=await prisma.financialCase.create({data:{sourceKey:randomUUID(),reservationId:r.id,customerId:u.id,kind:"RENTAL",amountCents:15000,reason:"Uncertain provider result"}});
  await expect(resolveFinancialCase(u,{caseId:c.id,action:"ESCALATE",reason:"Customer cannot resolve their own financial review"})).rejects.toThrow("Forbidden");
  const admin=await createTestCustomer({role:"ADMIN"});users.push(admin.id);
  await expect(resolveFinancialCase(admin,{caseId:c.id,action:"ESCALATE",reason:""})).rejects.toThrow("reason");
  await expect(resolveFinancialCase(admin,{caseId:c.id,action:"CONFIRM_FAILURE",reason:"No provider identity is not sufficient failure evidence"})).rejects.toThrow("identity");
  await resolveFinancialCase(admin,{caseId:c.id,action:"ESCALATE",reason:"Provider records require further manual investigation"});expect((await prisma.financialCase.findUniqueOrThrow({where:{id:c.id}})).status).toBe("MANUAL_REVIEW");expect(provider.refunds.create).not.toHaveBeenCalled();
 });
 it("selects urgent work ahead of thousands of historical observations",async()=>{
  const {r}=await fixture();await prisma.financialOperation.createMany({data:Array.from({length:2500},(_,i)=>({key:r.id+":"+i,kind:"DEPOSIT",reservationId:r.id,fingerprint:"historical",payload:{},state:"OBSERVED",createdAt:new Date(0)}))});
  const urgent=await prisma.financialOperation.create({data:{key:randomUUID(),kind:"DEPOSIT",reservationId:r.id,fingerprint:"urgent",payload:{},state:"RETRY",priority:0,nextAttemptAt:new Date(0)}});
  const selected=await dueOperations("DEPOSIT");expect(selected.some(o=>o.id===urgent.id)).toBe(true);expect(selected.every(o=>o.state!=="OBSERVED")).toBe(true);
  await prisma.financialOperation.update({where:{id:urgent.id},data:{state:"REVIEW"}});
  const target="pi_urgent_release_"+r.id;
  await prisma.financialOperation.create({data:{key:randomUUID(),kind:"DEPOSIT",reservationId:r.id,providerId:target,fingerprint:"target",payload:{},state:"OBSERVED"}});
  const { planDepositRelease }=await import("@/lib/deposit-release-plan");await withReservationLock(r.id,tx=>planDepositRelease(tx,r.id,target));
  provider.paymentIntents.retrieve.mockResolvedValue({id:target,status:"canceled"});
  await prisma.securityDeposit.create({data:{reservationId:r.id,amountCents:30000}});
  await recoverDeposits();expect(provider.paymentIntents.retrieve).toHaveBeenCalledWith(target);
  expect(provider.paymentIntents.create).not.toHaveBeenCalled();
 });
});
