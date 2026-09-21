import type {Prisma} from "@prisma/client";
import {jurisdictionDecision,requireReservationJurisdiction,requireVehicleJurisdiction} from "@/lib/jurisdiction";
import {requireReleaseFeature} from "@/lib/release-control";

/** Global order: release fence -> subject guard/row -> LegalDocument -> acceptance.
 * Readers hold SHARE through commit; administrative authority writers take EXCLUSIVE.
 * This is an admission fence, never a reason to reject compensating recovery.
 */
export async function releaseAuthorityFence(tx:Prisma.TransactionClient,exclusive=false){
 if(exclusive)await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('release-control',0))::text`;
 else await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('release-control',0))::text`;
}
export async function requireHostingAdmission(tx:Prisma.TransactionClient,subject:{vehicleId:string}|{code:string|null|undefined}){
 await releaseAuthorityFence(tx);
 const scope="vehicleId" in subject?await requireVehicleJurisdiction(tx,subject.vehicleId,"ACTIVATION"):await jurisdictionDecision(tx,subject.code,"HOSTING");
 await requireReleaseFeature("hosting",tx,scope.code);
 return scope;
}
export async function requireConfirmationAdmission(tx:Prisma.TransactionClient,reservationId:string){
 await releaseAuthorityFence(tx);
 const scope=await requireReservationJurisdiction(tx,reservationId,"CONFIRMATION");
 await requireReleaseFeature("booking",tx,scope.code);
}
