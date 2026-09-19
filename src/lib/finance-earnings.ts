import { prisma } from "@/lib/prisma";
import { financeHost } from "@/lib/finance-access";
import { lockPayoutReservations,payoutEligibility } from "@/lib/payout-authority";

// A display observation is not payout authority. Dispatch repeats these checks
// under the provider guard, even if this page just showed AVAILABLE.
export async function earningStatus(userId:string,reservationId:string,hostId:string){
 return prisma.$transaction(async tx=>{
  await lockPayoutReservations(tx,[reservationId],hostId);await financeHost(tx,userId,hostId);
  const result=await payoutEligibility(tx,reservationId),r=await tx.reservation.findUniqueOrThrow({where:{id:reservationId},select:{status:true,pickupAt:true}});
  const item=result.earning?await tx.payoutItem.findFirst({where:{earningId:result.earning.id,active:true}}):null,batch=item?await tx.payoutBatch.findUniqueOrThrow({where:{id:item.batchId}}):null;
  const disputed=await tx.providerDispute.count({where:{reservationId,active:true}});
  let state="PENDING";
  if(disputed)state="DISPUTED";
  else if(batch?.state==="PAID"||batch?.state==="REVERSED")state=batch.state;
  else if(result.earning&&result.amountCents===0&&result.earning.refundedCents>0)state="REFUNDED";
  else if(result.eligible)state="AVAILABLE";
  else if(batch)state=["PAYOUT_FAILED","REVIEW"].includes(batch.state)?"ON_HOLD":"PENDING";
  else if(result.reasons.some(reason=>!['Completed trip required','Approved return inspection required','Accepted return evidence required','Settlement delay has not elapsed'].includes(reason)))state="ON_HOLD";
  else if(r.status!=="COMPLETED"&&r.pickupAt>new Date())state="UPCOMING";
  return {state,reasons:result.reasons,availableAt:result.availableAt,batchId:batch?.id??null};
 },{timeout:15000});
}
