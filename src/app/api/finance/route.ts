import { auth } from "@/auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { boundedBody } from "@/lib/bounded-request";
import { MarketplaceError,marketplaceLimit } from "@/lib/marketplace";
import { financeAdmin,financeHost } from "@/lib/finance-access";
import { saveFinanceRule } from "@/lib/finance-rules";
import { connectOnboarding,synchronizeConnect,createPayoutBatch,planTransferReversal,retryBankPayout } from "@/lib/payout-operations";
import { proposeAdjustment,approveAdjustment,updatePayoutSchedule,grantFinance,resolveFinanceIssue } from "@/lib/finance-admin";
import { issueFinanceDocument } from "@/lib/finance-documents";
import { requestAuthCode } from "@/lib/auth-code";
import { safeLog } from "@/lib/safe-log";
export async function POST(req:Request){
 const session=await auth();if(!session?.user)return Response.json({error:"Sign in to continue."},{status:401});
 const origin=new URL(process.env.AUTH_URL??process.env.NEXTAUTH_URL??req.url).origin;if(req.headers.get("origin")!==origin)return Response.json({error:"Invalid origin."},{status:403});
 try{const userId=session.user.id;await marketplaceLimit(userId);const d=JSON.parse((await boundedBody(req,24000)).toString("utf8"));let result:unknown;
 switch(d.action){
  case "onboarding": result=await connectOnboarding(userId);break;
  case "sync": {const {host}=await financeHost(prisma,userId,undefined,true);await synchronizeConnect(host.id);result={success:true};break;}
  case "batch": {const {host}=await financeHost(prisma,userId,undefined,true);result=await createPayoutBatch(host.id);break;}
  case "schedule": result=await updatePayoutSchedule(userId,d);break;
  case "grant": result=await grantFinance(userId,z.string().parse(d.employeeId),d.manage==="yes");break;
  case "revokeGrant": {const {host,owner}=await financeHost(prisma,userId,undefined,true);if(!owner)throw new MarketplaceError("Owner required.",403);const e=await prisma.hostEmployee.findFirstOrThrow({where:{id:z.string().parse(d.employeeId),hostId:host.id}});await prisma.$transaction(async tx=>{await tx.financeGrant.deleteMany({where:{hostId:host.id,userId:e.userId}});await tx.auditLog.create({data:{actorId:userId,action:"finance.permission.revoked",entityType:"HostEmployee",entityId:e.id}});});result={success:true};break;}
  case "stepUp": {const a=await financeAdmin(prisma,userId,true);const sent=await requestAuthCode({email:a.email,ip:null,purpose:"FINANCE_STEP_UP"});if(!sent.ok)throw new MarketplaceError("Wait before requesting another code.",429);result={success:true};break;}
  case "rule": {const kind=z.enum(["COMMISSION","TAX","PAYOUT","LOSS"]).parse(d.kind);const config=kind==="COMMISSION"?{basisPoints:d.basisPoints,fixedCents:d.fixedCents,minimumCents:d.minimumCents,maximumCents:d.maximumCents,hostDiscountBps:d.hostDiscountBps}:kind==="TAX"?{jurisdiction:d.scopeId,rentalBps:d.rentalBps,feeBps:d.feeBps,extrasTaxable:d.extrasTaxable==="yes",exemptionsAllowed:d.exemptionsAllowed==="yes"}:kind==="PAYOUT"?{delayDays:d.delayDays,minimumCents:d.minimumCents,allowedSchedules:["MANUAL","WEEKLY","TWICE_MONTHLY","MONTHLY"],hostMaySelect:d.hostMaySelect==="yes",timezone:d.timezone}:{refundHostBps:d.refundHostBps,chargebackHostBps:d.chargebackHostBps,reverseTransfers:d.reverseTransfers==="yes"};result=await saveFinanceRule(userId,{...d,kind,config,endsAt:d.endsAt||undefined,approve:d.approve==="yes"});break;}
  case "adjustment": result=await proposeAdjustment(userId,d);break;
  case "approveAdjustment": result=await approveAdjustment(userId,z.string().parse(d.id),z.string().parse(d.stepUpCode));break;
  case "reversal": result=await planTransferReversal(userId,z.string().parse(d.id),z.string().parse(d.stepUpCode));break;
  case "retryPayout": result=await retryBankPayout(userId,z.string().parse(d.id),z.string().parse(d.stepUpCode));break;
  case "resolve": result=await resolveFinanceIssue(userId,z.string().parse(d.id),z.string().parse(d.stepUpCode),z.string().parse(d.reason));break;
  case "document": result=await issueFinanceDocument(userId,z.object({kind:z.string(),reservationId:z.string().optional(),batchId:z.string().optional(),period:z.string().optional(),newVersion:z.boolean().default(false)}).parse(d));break;
  default: throw new MarketplaceError("Unknown finance action.");
 }return Response.json(result,{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){if(error instanceof MarketplaceError)return Response.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return Response.json({error:"Check the required fields and permitted values."},{status:400});safeLog("FINANCE_ACTION_FAILED",error);return Response.json({error:"Finance action needs review or refreshed state. Test-mode provider configuration may be required."},{status:409});}
}
