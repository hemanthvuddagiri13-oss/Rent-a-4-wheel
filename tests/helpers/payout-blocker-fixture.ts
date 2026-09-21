import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma,createTestHost,createTestCustomer,createTestVehicle,createTestReservation,cleanupReservationsForVehicles } from './factories';
import { withReservationLock } from '@/lib/financial-locks';
import { accountReservation } from '@/lib/finance-ledger';
export { prisma };
export const one=new PrismaClient(),two=new PrismaClient(),users:string[]=[],hosts:string[]=[],vehicles:string[]=[];
export async function fixture(reuse?:{h:Awaited<ReturnType<typeof createTestHost>>;customer:Awaited<ReturnType<typeof createTestCustomer>>;v:Awaited<ReturnType<typeof createTestVehicle>>},stripePaymentIntentId?:string){
 const h=reuse?.h??await createTestHost(),customer=reuse?.customer??await createTestCustomer();const v=reuse?.v??await createTestVehicle({hostId:h.hostProfile.id});if(!reuse){users.push(h.user.id,customer.id);hosts.push(h.hostProfile.id);vehicles.push(v.id);}
 const offset=reuse?await prisma.reservation.count({where:{vehicleId:v.id}}):0;
 const r=await createTestReservation({vehicleId:v.id,customerId:customer.id,pickupAt:new Date(Date.UTC(2041,0,1+offset*4)),returnAt:new Date(Date.UTC(2041,0,4+offset*4)),status:"COMPLETED"});
 await prisma.trip.create({data:{reservationId:r.id,startedAt:new Date(Date.now()-86400000*4),endedAt:new Date(Date.now()-86400000*2)}});
 await prisma.tripEvent.create({data:{reservationId:r.id,type:"RETURN_REVIEWED",actorId:h.user.id}});
 for(const [submittedById,submittedByRole]of [[customer.id,"CUSTOMER"],[h.user.id,"HOST"]]as const)await prisma.conditionReport.create({data:{reservationId:r.id,phase:"POST_TRIP",submittedById,submittedByRole,acceptedAt:new Date(),mileage:500,fuelLevel:100,photos:{create:[{category:"EXTERIOR",storageKey:"local:finance-fixture"},{category:"INTERIOR",storageKey:"local:finance-fixture"}]}}});
 const payment=await prisma.payment.create({data:{reservationId:r.id,type:"RENTAL",status:"SUCCEEDED",amountCents:r.totalCents,stripePaymentIntentId}});
 await prisma.financeQuote.create({data:{reservationId:r.id,terms:{commission:{version:1},tax:{version:1},settlement:{delayDays:1,minimumCents:1,loss:{refundHostBps:10000,chargebackHostBps:10000,reverseTransfers:true}},amounts:{grossCents:15000,hostDiscountCents:0,platformDiscountCents:0,commissionCents:1500,hostNetCents:13500,rentalTaxCents:0,feeTaxCents:0,feesCents:0,totalCents:15000},approved:true}}});
 await withReservationLock(r.id,tx=>accountReservation(tx,r.id));
 if(!reuse)await prisma.connectAccount.create({data:{hostId:h.hostProfile.id,accountId:"acct_"+randomUUID(),detailsSubmitted:true,payoutsEnabled:true,verificationStatus:"VERIFIED",synchronizedAt:new Date(),minimumCents:1}});
 return {h,customer,v,r,payment};
}

export async function cleanup(){
 const db=(await prisma.$queryRawUnsafe<Array<{name:string}>>('SELECT current_database() name'))[0].name;if(!db.endsWith('_test'))throw Error('Disposable database required');
 await prisma.$executeRawUnsafe('TRUNCATE "AccountingCheckpoint","PayoutBankProjection","FinanceDocument","LedgerLine","LedgerJournal","PayoutItem","PayoutReversal","PayoutBatch","HostEarning","FinanceObject","FinanceIssue","FinanceAdjustment","ProviderDispute","ConnectAccount","FinanceGrant" CASCADE');
 await prisma.financialOperation.deleteMany({where:{kind:{startsWith:'FINANCE_'}}});await cleanupReservationsForVehicles(vehicles);await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.authCode.deleteMany({where:{email:{in:(await prisma.user.findMany({where:{id:{in:users}},select:{email:true}})).map(u=>u.email)}}});await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.hostProfile.deleteMany({where:{id:{in:hosts}}});await prisma.user.deleteMany({where:{id:{in:users}}});await Promise.all([one.$disconnect(),two.$disconnect(),prisma.$disconnect()]);
}
