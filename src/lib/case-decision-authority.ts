import type { Prisma, ServiceCase } from "@prisma/client";
import { isOperator, type ServiceKind } from "@/lib/collaboration-access";
import { marketplaceActor, MarketplaceError } from "@/lib/marketplace";

// Called under reservation -> case locks, for assignment AND every decision.
export async function independentCaseActor(tx: Prisma.TransactionClient, c: Pick<ServiceCase,"id"|"kind"|"reservationId"|"vehicleId"|"openedById">, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
  const actor = await marketplaceActor(tx, userId);
  if (!isOperator(actor.role, c.kind as ServiceKind)) throw new MarketplaceError("An authorized independent agent is required.",403);
  const r = c.reservationId ? await tx.reservation.findUniqueOrThrow({where:{id:c.reservationId}}) : null;
  const v = c.vehicleId ? await tx.vehicle.findUniqueOrThrow({where:{id:c.vehicleId},include:{host:true,owner:true}}) : null;
  const affiliation = v?.hostId ? await tx.$queryRaw<Array<{userId:string}>>`SELECT "userId" FROM "HostAffiliationHistory" WHERE "hostId"=${v.hostId} AND "userId"=${userId}` : [];
  const ownerHost = v?.owner?.hostId ? await tx.hostProfile.findUnique({where:{id:v.owner.hostId}}) : null;
  const caseIds = r ? (await tx.serviceCase.findMany({where:{reservationId:r.id},select:{id:true}})).map(x=>x.id) : [c.id];
  const evidence = await tx.collaborationFile.count({where:{caseId:{in:caseIds},uploadedById:userId}});
  const participation = await tx.serviceCaseEvent.count({where:{caseId:{in:caseIds},actorId:userId,action:{in:["OPEN","CUSTOMER_REPLY","HOST_REPLY","APPEAL"]}}});
  const openedCase = await tx.serviceCase.count({where:{id:{in:caseIds},openedById:userId}});
  const originalEvidence = r ? await tx.conditionReport.count({where:{reservationId:r.id,submittedById:userId}}) : 0;
  if (openedCase || r?.customerId===userId || v?.host?.userId===userId || ownerHost?.userId===userId || v?.owner?.email?.trim().toLowerCase()===actor.email.trim().toLowerCase() || affiliation.length || evidence || participation || originalEvidence) {
    throw new MarketplaceError("A participant, owner, current or former affiliate, or evidence submitter cannot adjudicate this case.",403);
  }
  return actor;
}
