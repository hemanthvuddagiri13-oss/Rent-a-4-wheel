import type { Prisma } from "@prisma/client";
import { marketplaceActor, MarketplaceError } from "@/lib/marketplace";
import { activeHostEmployeeWhere } from "@/lib/host-access";
import { verifyAuthCode } from "@/lib/auth-code";

export async function financeAdmin(tx:Prisma.TransactionClient,userId:string,superOnly=false) {
 const actor=await marketplaceActor(tx,userId);
 if(!(superOnly?["SUPER_ADMIN"]:["FINANCE_AGENT","ADMIN","SUPER_ADMIN"]).includes(actor.role)) throw new MarketplaceError("Finance administration access required.",403);
 return actor;
}
export async function financeHost(tx:Prisma.TransactionClient,userId:string,hostId?:string,manage=false) {
 const actor=await marketplaceActor(tx,userId);
 const own=await tx.hostProfile.findUnique({where:{userId}});
 const membership=own?null:await tx.hostEmployee.findFirst({where:activeHostEmployeeWhere(userId),include:{host:true}});
 const host=own??membership?.host;
 if(!host || hostId && host.id!==hostId) throw new MarketplaceError("Host finance unavailable.",404);
 if(!own){const grant=await tx.financeGrant.findUnique({where:{hostId_userId:{hostId:host.id,userId}}});if(!grant || manage && (!grant.manage || membership?.role!=="MANAGER")) throw new MarketplaceError("Explicit host finance permission is required.",403);}
 if(manage && (host.onboardingStatus!=="APPROVED" || !await tx.user.count({where:{id:host.userId,isActive:true}}))) throw new MarketplaceError("Approved active host required.",403);
 return {actor,host,owner:Boolean(own)};
}
export async function financeStepUp(tx:Prisma.TransactionClient,userId:string,code:string) {
 await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
 const actor=await financeAdmin(tx,userId,true);
 if(!/^\d{6}$/.test(code)||!(await verifyAuthCode({email:actor.email,code,ip:null,purpose:"FINANCE_STEP_UP"})).ok) throw new MarketplaceError("A fresh finance step-up code is required.",403);
 return actor;
}
export const money=(cents:number,currency="usd")=>new Intl.NumberFormat("en-US",{style:"currency",currency:currency.toUpperCase()}).format(cents/100);
export function csvCell(value:unknown){const text=String(value??"");return '"'+(/^[\s]*[=+\-@\t\r\n]/.test(text)?"'":"")+text.replaceAll('"','""')+'"';}
