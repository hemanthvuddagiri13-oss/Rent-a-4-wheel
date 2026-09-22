import type {Prisma} from "@prisma/client";
import {prisma} from "@/lib/prisma";
import {deploymentEnvironment} from "@/lib/deployment-environment";
export const JURISDICTION_GATES=["ENTITY","LEGAL","INSURANCE","TAX","PRIVACY_RETENTION","OPERATIONS","PAYMENTS","HOST_PAYOUTS","LOCAL_RESTRICTIONS","HOST_ELIGIBILITY","GUEST_ELIGIBILITY","VEHICLE_ELIGIBILITY"] as const;
export type JurisdictionAction="HOSTING"|"ACTIVATION"|"SEARCH"|"CHECKOUT"|"PAYMENT"|"CONFIRMATION"|"TRIP_START"|"PAYOUT";
export class JurisdictionUnavailable extends Error {constructor(){super("Jurisdiction is not released for this action.");}}
/** Call inside the existing authority transaction. The shared row lock fences disablement. */
export async function jurisdictionDecision(tx:Prisma.TransactionClient,code:string|null|undefined,action:JurisdictionAction){
 if(!code||!/^[A-Z]{2}$/.test(code)||deploymentEnvironment()==="production")throw new JurisdictionUnavailable();
 await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('release-control',0))::text`;
 await tx.$queryRaw`SELECT code FROM "Jurisdiction" WHERE code=${code} FOR SHARE`;
 const row=await tx.jurisdiction.findUnique({where:{code}});if(!row||row.mode!=="STAGING")throw new JurisdictionUnavailable();
 const now=new Date(),versions=await tx.jurisdictionApproval.findMany({where:{jurisdictionCode:code,effectiveAt:{lte:now}},orderBy:[{version:"desc"}]});
 const selected=JURISDICTION_GATES.map(category=>versions.find(v=>v.category===category));
 if(selected.some(v=>!v||v.status!=="STAGING_READY"||!v.reviewedAt||!v.reviewedById||v.endsAt&&v.endsAt<=now))throw new JurisdictionUnavailable();
 return {code,version:row.version,mode:row.mode,action,productionApproved:false,approvals:selected.map(v=>({category:v!.category,id:v!.id,version:v!.version,contentHash:v!.contentHash}))};
}
export async function requireVehicleJurisdiction(tx:Prisma.TransactionClient,vehicleId:string,action:JurisdictionAction){const v=await tx.vehicle.findUniqueOrThrow({where:{id:vehicleId},select:{jurisdictionCode:true}});return jurisdictionDecision(tx,v.jurisdictionCode,action);}
export async function requireReservationJurisdiction(tx:Prisma.TransactionClient,id:string,action:JurisdictionAction){const r=await tx.reservation.findUniqueOrThrow({where:{id},select:{jurisdictionCode:true,vehicleId:true}});return r.jurisdictionCode?jurisdictionDecision(tx,r.jurisdictionCode,action):requireVehicleJurisdiction(tx,r.vehicleId,action);}
export async function visibleJurisdictions(){const rows=await prisma.jurisdiction.findMany({where:{mode:"STAGING"}}),codes:string[]=[];for(const row of rows)try{await prisma.$transaction(tx=>jurisdictionDecision(tx,row.code,"SEARCH"));codes.push(row.code);}catch{/* Disabled, incomplete or production: never visible. */}return codes;}
