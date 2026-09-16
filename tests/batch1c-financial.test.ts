import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma, createTestVehicle, createTestCustomer, createTestReservation, cleanupReservationsForVehicles } from "./helpers/factories";
import { prisma as workerDb } from "@/lib/prisma";
import { barrier } from "./helpers/barrier";
import { handlePaymentIntentSucceeded } from "@/lib/stripe-webhook-handlers";
import { syncDepositIntent, attemptDepositAuthorization, releaseDeposits } from "@/lib/deposit-authorization";
import { getOrCreateRefundOperation, executeRefundOperation, reconcileRefundStatus } from "@/lib/refund-operations";
import { financialProjection } from "@/lib/financial-projection";
import { recoverRefunds } from "@/lib/financial-workers";
import { fingerprint } from "@/lib/financial-operations";
import { withReservationLock, assertFinancialTripStart } from "@/lib/financial-locks";
import { transitionReservation } from "@/lib/reservation-state-machine";
import { createOrRefreshHold } from "@/lib/checkout-hold";
import { expireStaleReservations } from "@/lib/cleanup";
const provider = vi.hoisted(() => ({ refunds: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() }, paymentIntents: { create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ stripe: provider }));
const vehicles: string[] = [], users: string[] = [];
const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("connection_limit", "1");
const a = new PrismaClient({ datasources: { db: { url: url.toString() } } }), b = new PrismaClient({ datasources: { db: { url: url.toString() } } });
afterEach(() => { vi.restoreAllMocks(); for (const group of Object.values(provider)) for (const fn of Object.values(group)) fn.mockReset(); });
afterAll(async () => { await cleanupReservationsForVehicles(vehicles); await prisma.bookingDraft.deleteMany({ where: { vehicleId: { in: vehicles } } }); await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await Promise.all([a.$disconnect(), b.$disconnect(), prisma.$disconnect()]); });
async function fixture(depositCents = 0, paid = true) {
 const v=await createTestVehicle(), u=await createTestCustomer(); vehicles.push(v.id); users.push(u.id);
 const r=await createTestReservation({ vehicleId:v.id, customerId:u.id, pickupAt:new Date("2032-01-01"), returnAt:new Date("2032-01-04"), status:"CONFIRMED", depositCents });
 const p=await prisma.payment.create({ data:{reservationId:r.id,type:"RENTAL",status:paid?"SUCCEEDED":"REQUIRES_PAYMENT",amountCents:15000,stripePaymentIntentId:`pi_${r.id}`} });
 if(depositCents) await prisma.securityDeposit.create({data:{reservationId:r.id,amountCents:depositCents}});
 return {r,p};
}
const capture = (id:string, amount=30000) => ({id,status:"requires_capture",amount,amount_capturable:amount,currency:"usd",created:Math.floor(Date.now()/1000),latest_charge:{created:Math.floor(Date.now()/1000),payment_method_details:{card:{capture_before:Math.floor(Date.now()/1000)+3600}}}});
const rental = {payment_method:"pm_fixture",customer:"cus_fixture"} as never;
async function snapshot(id:string){return prisma.reservation.findUniqueOrThrow({where:{id},include:{payments:true,refunds:true,deposit:true}})}
async function waitLock(pid:number) { const deadline=Date.now()+4000; while(Date.now()<deadline){const rows=await prisma.$queryRaw<Array<{wait_event_type:string}>>`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`; if(rows[0]?.wait_event_type==="Lock") return;await new Promise(r=>setTimeout(r,5));}throw new Error("No concurrent lock wait observed"); }
describe("Batch 1C financial regressions",()=>{
 it("timeout recovery cannot convert REVIEW into an automatic refund mandate", async () => {
   const {r}=await fixture();await prisma.reservation.update({where:{id:r.id},data:{status:"PAYMENT_FAILED",financialDisposition:"REVIEW",expiresAt:new Date(0)}});
   await expireStaleReservations();const saved=await snapshot(r.id);
   expect(saved.financialDisposition).toBe("REVIEW");expect(saved.status).toBe("PAYMENT_FAILED");expect(saved.refunds).toHaveLength(0);expect(provider.refunds.create).not.toHaveBeenCalled();
 });
 it("quarantines migrated unknown deposit/refund outcomes without sending replacement operations", async () => {
   const {r,p}=await fixture(30000);
   await prisma.securityDeposit.update({where:{reservationId:r.id},data:{legacyUncertain:true}});
   const refund=await prisma.refund.create({data:{reservationId:r.id,paymentId:p.id,amountCents:1000,status:"PENDING",idempotencyKey:`legacy-key:${r.id}`,legacyUncertain:true}});
   await expect(attemptDepositAuthorization(await snapshot(r.id),rental,true)).rejects.toThrow("Legacy deposit");
   await expect(executeRefundOperation(refund.id,p.stripePaymentIntentId)).rejects.toThrow("Legacy refund");
   expect(provider.paymentIntents.create).not.toHaveBeenCalled();expect(provider.refunds.create).not.toHaveBeenCalled();
   expect(await prisma.financialOperation.count({where:{reservationId:r.id}})).toBe(0);
 });
 it("two overlapping renewals cannot release a replacement that subsequently starts a trip", async () => {
   const {r}=await fixture(30000); const old=capture(`pi_old_${r.id}`), next=capture(`pi_next_${r.id}`);
   provider.paymentIntents.create.mockResolvedValueOnce(old);
   await attemptDepositAuthorization(await snapshot(r.id),rental);
   await prisma.securityDeposit.update({where:{reservationId:r.id},data:{authorizationExpiresAt:new Date(0)}});
   const stale=await snapshot(r.id); const entered=barrier(),release=barrier();
   const ledger=new Map([[old.id,old],[next.id,next]]);
   provider.paymentIntents.retrieve.mockImplementation(async id=>ledger.get(id));
   provider.paymentIntents.cancel.mockImplementation(async id=>{const result={...ledger.get(id)!,status:"canceled"};ledger.set(id,result);return result});
   provider.paymentIntents.create.mockImplementationOnce(async()=>{entered.release();await release.wait;return next});
   const first=attemptDepositAuthorization(stale,rental,true);await entered.wait;
   await expect(attemptDepositAuthorization(stale,rental,true)).rejects.toThrow("already processing");
   await expect(withReservationLock(r.id,tx=>assertFinancialTripStart(tx,r.id),a)).rejects.toThrow("deposit");
   release.release();await first;
   await withReservationLock(r.id,async tx=>{await transitionReservation(tx,{id:r.id,from:"CONFIRMED",to:"ACTIVE",force:true});await tx.trip.create({data:{reservationId:r.id,startedAt:new Date()}})},b);
   // A delayed request still holding generation 1 may only release generation 1.
   await attemptDepositAuthorization(stale,rental,true);
   expect(provider.paymentIntents.cancel.mock.calls.every(([id])=>id===old.id)).toBe(true);
   const saved=await snapshot(r.id);expect(saved.status).toBe("ACTIVE");expect(saved.deposit?.stripePaymentIntentId).toBe(next.id);expect(saved.deposit?.status).toBe("SUCCEEDED");
 });
 it.each(["DISPUTED","UNDER_CLAIM_REVIEW"] as const)("never fulfills a success replay in %s",async status=>{const {r,p}=await fixture();await prisma.reservation.update({where:{id:r.id},data:{status}});await handlePaymentIntentSucceeded({id:p.stripePaymentIntentId} as never);expect((await snapshot(r.id)).status).toBe(status);expect(provider.refunds.create).not.toHaveBeenCalled();});
 it("keeps external partial-refund REVIEW separate from a refund mandate",async()=>{const {r,p}=await fixture();provider.refunds.retrieve.mockResolvedValue({id:`re_external_${r.id}`,payment_intent:p.stripePaymentIntentId,amount:1000,status:"succeeded",metadata:{}});await reconcileRefundStatus(`re_external_${r.id}`,"succeeded");await handlePaymentIntentSucceeded({id:p.stripePaymentIntentId} as never);const saved=await snapshot(r.id);expect(saved.status).toBe("CONFIRMED");expect(saved.financialDisposition).toBe("REVIEW");expect(saved.refunds).toHaveLength(1);expect(provider.refunds.create).not.toHaveBeenCalled();});
 it("does not restore a canceled deposit from a stale capture observation",async()=>{const {r}=await fixture(30000);const remote=capture(`pi_d_${r.id}`);provider.paymentIntents.create.mockResolvedValue(remote);await attemptDepositAuthorization(await snapshot(r.id),rental);await syncDepositIntent(r.id,{...remote,status:"canceled"} as never);await syncDepositIntent(r.id,remote as never);expect((await snapshot(r.id)).deposit?.status).toBe("CANCELLED");await expect(withReservationLock(r.id,tx=>assertFinancialTripStart(tx,r.id))).rejects.toThrow("deposit");});
 it("does not acknowledge release when Stripe has not canceled the authorization",async()=>{const {r}=await fixture(30000);const remote=capture(`pi_release_${r.id}`);provider.paymentIntents.create.mockResolvedValue(remote);provider.paymentIntents.retrieve.mockResolvedValue(remote);await attemptDepositAuthorization(await snapshot(r.id),rental);provider.paymentIntents.cancel.mockRejectedValueOnce(new Error("network failure before cancellation"));await expect(releaseDeposits(r.id)).rejects.toThrow();expect((await prisma.financialOperation.findUniqueOrThrow({where:{key:`deposit-release:${remote.id}`}})).state).toBe("RETRY");expect((await snapshot(r.id)).deposit?.releasedAt).toBeNull();provider.paymentIntents.cancel.mockResolvedValue({...remote,status:"canceled"});await releaseDeposits(r.id);expect(provider.paymentIntents.cancel).toHaveBeenCalledTimes(2);expect((await snapshot(r.id)).deposit?.releasedAt).not.toBeNull();});
 it("an unpaid cancellation is cancelled, not refund_pending",async()=>{const {r}=await fixture(0,false);await prisma.reservation.update({where:{id:r.id},data:{status:"AWAITING_PAYMENT"}});await withReservationLock(r.id,tx=>transitionReservation(tx,{id:r.id,from:"AWAITING_PAYMENT",to:"CANCELLED_BY_CUSTOMER"}));expect(financialProjection(await snapshot(r.id)).outcome).toBe("cancelled");});
 it("blocks a deposit amount mismatch and distinguishes partial and failed refunds",async()=>{const {r,p}=await fixture(30000);await prisma.securityDeposit.update({where:{reservationId:r.id},data:{status:"SUCCEEDED",stripeStatus:"requires_capture",amountCents:29999,authorizationExpiresAt:new Date(Date.now()+60000)}});expect(financialProjection(await snapshot(r.id)).outcome).toBe("payment_failed");const refund=await getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:1000,idempotencyKey:`projection:${r.id}`});await prisma.refund.update({where:{id:refund.id},data:{status:"SUCCEEDED"}});expect(financialProjection(await snapshot(r.id)).refundStatus).toBe("partial");await prisma.refund.update({where:{id:refund.id},data:{status:"FAILED"}});expect(financialProjection(await snapshot(r.id)).outcome).toBe("refund_failed");});
 it("rejects refunds while an unfinished Trip exists even under DISPUTED",async()=>{const {r,p}=await fixture();await prisma.reservation.update({where:{id:r.id},data:{status:"DISPUTED"}});await prisma.trip.create({data:{reservationId:r.id,startedAt:new Date()}});await expect(getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:1000,idempotencyKey:`active:${r.id}`})).rejects.toThrow("unfinished");});
 it("staff cancellation waits for trip start and cannot cancel its committed trip",async()=>{const {r}=await fixture();const entered=barrier(),release=barrier();const start=withReservationLock(r.id,async tx=>{await transitionReservation(tx,{id:r.id,from:"CONFIRMED",to:"ACTIVE",force:true});await tx.trip.create({data:{reservationId:r.id,startedAt:new Date()}});entered.release();await release.wait;},a);await entered.wait;const [{pid}]=await b.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;const cancel=withReservationLock(r.id,tx=>transitionReservation(tx,{id:r.id,from:"CONFIRMED",to:"CANCELLED_BY_HOST",force:true}),b);const rejected=expect(cancel).rejects.toThrow("cannot be cancelled");try{await waitLock(pid)}finally{release.release()}await Promise.all([start,rejected]);expect((await snapshot(r.id)).status).toBe("ACTIVE");});
 it("rejects an obsolete quote/hold request when two requests finish in reverse order",async()=>{
   const {r}=await fixture(0,false);await prisma.reservation.update({where:{id:r.id},data:{status:"CHECKOUT_HOLD",expiresAt:new Date(Date.now()+60000)}});
   const base={customerId:r.customerId,vehicleId:r.vehicleId,extraIds:[],draftId:crypto.randomUUID()};
   const entered=barrier(),release=barrier();
   const first=(async()=>{entered.release();await release.wait;return createOrRefreshHold({...base,revision:1,pickupAt:r.pickupAt,returnAt:r.returnAt},a)})();
   const rejected=expect(first).rejects.toThrow("Obsolete");await entered.wait;
   const newer=await createOrRefreshHold({...base,revision:2,pickupAt:new Date("2032-03-01"),returnAt:new Date("2032-03-03")},b);
   release.release();await rejected;expect((await snapshot(newer.id)).status).toBe("CHECKOUT_HOLD");
 });
 it("fences an old refund worker with real projections and an immutable provider ledger",async()=>{const {r,p}=await fixture();const refund=await getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:15000,idempotencyKey:`takeover:${r.id}`});const entered=barrier(),release=barrier();const ledger=new Map<string,{hash:string,result:{id:string,status:string}}>();let calls=0;provider.refunds.create.mockImplementation(async(params,options)=>{const hash=fingerprint(params),old=ledger.get(options.idempotencyKey);if(old&&old.hash!==hash)throw new Error("Provider parameter mismatch");if(!old)ledger.set(options.idempotencyKey,{hash,result:{id:`re_takeover_${r.id}`,status:"succeeded"}});if(++calls===1){entered.release();await release.wait}return ledger.get(options.idempotencyKey)!.result;});const first=executeRefundOperation(refund.id,p.stripePaymentIntentId);const rejected=expect(first).rejects.toThrow("lease lost");await entered.wait;await prisma.financialOperation.update({where:{key:refund.idempotencyKey},data:{leaseExpiresAt:new Date(0)}});await executeRefundOperation(refund.id,p.stripePaymentIntentId);release.release();await rejected;expect(ledger.size).toBe(1);expect((await prisma.refund.findUniqueOrThrow({where:{id:refund.id}})).status).toBe("SUCCEEDED");expect(await prisma.outboxMessage.count({where:{deliveryKey:`refund:${refund.id}`}})).toBe(1);});
 it("advances eligible refunds beyond a 25-item uncertain backlog using the worker's actual client",async()=>{const {r,p}=await fixture();const ids:string[]=[];for(let i=0;i<30;i++){const f=await getOrCreateRefundOperation({reservationId:r.id,paymentId:p.id,amountCents:100,idempotencyKey:`backlog:${r.id}:${i}`});ids.push(f.id);await prisma.refund.update({where:{id:f.id},data:{updatedAt:new Date(i)}})}provider.refunds.create.mockImplementation(async params=>{if(ids.indexOf(params.metadata.refundId)<25)throw new Error("Uncertain outcome");return{id:`re_${params.metadata.refundId}`,status:"succeeded"}});const original=workerDb.refund.findMany.bind(workerDb.refund);const spy=vi.spyOn(workerDb.refund,"findMany").mockImplementation(args=>original({...args,where:{...args?.where,id:{in:ids}}}) as never);await recoverRefunds();await recoverRefunds();expect(spy).toHaveBeenCalledTimes(2);expect(await prisma.refund.count({where:{id:{in:ids.slice(25)},status:"SUCCEEDED"}})).toBe(5);expect(await prisma.refund.count({where:{id:{in:ids.slice(0,25)},status:"PENDING"}})).toBe(25);});
});
