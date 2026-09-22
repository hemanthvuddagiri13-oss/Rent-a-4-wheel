import {Prisma} from "@prisma/client";
import {prisma} from "@/lib/prisma";
import {localDevelopment,deploymentEnvironment} from "@/lib/deployment-environment";
import {fingerprint} from "@/lib/financial-operations";
import {policy} from "@/lib/collaboration-access";

export async function lockRetentionPolicy(tx:Prisma.TransactionClient){
 await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('release-control',0))::text`;
}
/** Admission disablement never cancels already-authorized erasure/recovery.
 * New erasure needs independent approval of the exact configured schedule.
 * Unknown geography is retained for review, never inferred from an address.
 */
export async function retentionApproved(tx:Prisma.TransactionClient,reservationId:string|null){
 if(localDevelopment())return true;
 if(!reservationId)return false;
 const reservation=await tx.reservation.findUnique({where:{id:reservationId},select:{jurisdictionCode:true,vehicle:{select:{jurisdictionCode:true}}}});
 const code=reservation?.jurisdictionCode??reservation?.vehicle.jurisdictionCode;if(!code)return false;
 return retentionCodeApproved(tx,code);
}
async function retentionCodeApproved(tx:Prisma.TransactionClient,code:string){
 if(deploymentEnvironment()==="production")return false; // No jurisdiction has production approval in this phase.
 const gate=await tx.jurisdictionApproval.findFirst({where:{jurisdictionCode:code,category:"PRIVACY_RETENTION",effectiveAt:{lte:new Date()}},orderBy:{version:"desc"}});
 if(!gate||gate.status!=="STAGING_READY"||!gate.reviewedAt||!gate.reviewedById||gate.endsAt&&gate.endsAt<=new Date())return false;
 const approval=await tx.policyApproval.findFirst({where:{kind:"RETENTION",jurisdiction:"US-"+code,effectiveAt:{lte:new Date()}},orderBy:[{effectiveAt:"desc"},{createdAt:"desc"}]});
 return Boolean(approval?.status==="APPROVED"&&approval.approvedAt&&approval.approvedById&&approval.professionalReference&&approval.contentHash===fingerprint(await policy(tx)));
}
// Filter unapproved scopes before LIMIT so they cannot starve approved scopes.
// Recheck under the shared authority lock at every irreversible authorization point.
export async function retentionScopeFilter(){
 if(localDevelopment())return ()=>Prisma.sql`TRUE`;
 const codes:string[]=[];for(const row of await prisma.jurisdiction.findMany({select:{code:true}}))if(await retentionCodeApproved(prisma,row.code))codes.push(row.code);
 return (reservation:Prisma.Sql)=>codes.length?Prisma.sql`EXISTS (SELECT 1 FROM "Reservation" rp JOIN "Vehicle" vp ON vp.id=rp."vehicleId" WHERE rp.id=${reservation} AND COALESCE(rp."jurisdictionCode",vp."jurisdictionCode") IN (${Prisma.join(codes)}))`:Prisma.sql`FALSE`;
}
