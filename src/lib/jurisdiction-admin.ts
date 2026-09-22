import { z } from "zod";
import { protectedAdminMutation,type AdminExecution } from "@/lib/protected-admin";
import { JURISDICTION_GATES } from "@/lib/jurisdiction";
import { marketplacePricingSchema } from "@/lib/marketplace-pricing";
import { fingerprint, json } from "@/lib/financial-operations";

const common = {jurisdictionCode: z.string().regex(/^[A-Z]{2}$/), code: z.string().regex(/^\d{6}$/), reason: z.string().trim().min(10).max(500),confirm:z.literal(true)};
const evidence = {effectiveAt: z.string().datetime(), endsAt: z.string().datetime().optional(), status: z.enum(["SAMPLE", "STAGING_READY"])};
const command = z.discriminatedUnion("action", [
  z.object({...common, action: z.literal("jurisdictionMode"), mode: z.enum(["DISABLED", "STAGING"])}).strict(),
  z.object({...common, ...evidence, action: z.literal("jurisdictionGate"), category: z.enum(JURISDICTION_GATES), contentHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceReference: z.string().min(10).max(500)}).strict(),
  z.object({...common, ...evidence, action: z.literal("pricingPolicy"), config: marketplacePricingSchema}).strict(),
  z.object({...common, action: z.literal("revokeJurisdictionGate"), id: z.string().min(1).max(100)}).strict(),
  z.object({...common, action: z.literal("revokePricingPolicy"), id: z.string().min(1).max(100)}).strict(),
]);

export async function jurisdictionAdminCommand(userId: string, input: unknown,execution:AdminExecution) {
  const data = command.parse(input);
  if ("endsAt" in data && data.endsAt && data.endsAt <= data.effectiveAt) throw new Error("INVALID_EFFECTIVE_PERIOD");
  return protectedAdminMutation(userId,data,execution,data.action,async tx => {
    await tx.jurisdiction.findUniqueOrThrow({where: {code: data.jurisdictionCode}});
    let id: string = data.jurisdictionCode;
    if (data.action === "jurisdictionMode") await tx.jurisdiction.update({where: {code: data.jurisdictionCode}, data: {mode: data.mode}});
    else if (data.action === "revokeJurisdictionGate") await tx.jurisdictionApproval.update({where: {id: data.id, jurisdictionCode: data.jurisdictionCode}, data: {status: "REVOKED"}});
    else if (data.action === "revokePricingPolicy") await tx.marketplacePricingPolicy.update({where: {id: data.id, jurisdictionCode: data.jurisdictionCode}, data: {status: "REVOKED"}});
    else {
      const review = {jurisdictionCode: data.jurisdictionCode, status: data.status, reviewedById: data.status === "STAGING_READY" ? userId : null, reviewedAt: data.status === "STAGING_READY" ? new Date() : null, effectiveAt: new Date(data.effectiveAt), endsAt: data.endsAt ? new Date(data.endsAt) : null};
      if (data.action === "jurisdictionGate") {
        const previous = await tx.jurisdictionApproval.findFirst({where: {jurisdictionCode: data.jurisdictionCode, category: data.category}, orderBy: {version: "desc"}});
        id = (await tx.jurisdictionApproval.create({data: {...review, version: (previous?.version ?? 0)+1, category: data.category, contentHash: data.contentHash, evidenceReference: data.evidenceReference}})).id;
      } else {
        const previous = await tx.marketplacePricingPolicy.findFirst({where: {jurisdictionCode: data.jurisdictionCode}, orderBy: {version: "desc"}});
        id = (await tx.marketplacePricingPolicy.create({data: {...review, version: (previous?.version ?? 0)+1, config: json(data.config), contentHash: fingerprint(data.config), createdById: userId}})).id;
      }
    }
    await tx.auditLog.create({data: {actorId: userId, action: "jurisdiction."+data.action, entityType: "Jurisdiction", entityId: data.jurisdictionCode, metadata: {id, reason: data.reason, productionApproved: false}}});
    return {id, productionApproved: false};
  });
}
