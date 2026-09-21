import { z } from "zod";
import type { Prisma, Vehicle } from "@prisma/client";
import type { PricingBreakdown } from "@/lib/pricing";
import type { FinanceTerms } from "@/lib/finance-rules";
import { fingerprint } from "@/lib/financial-operations";
import { localDevelopment } from "@/lib/deployment-environment";

const cents = z.number().int().min(0).max(100_000_000);
const bps = z.number().int().min(0).max(10_000);
const fee = z.object({ basisPoints: bps, flatCents: cents, minimumCents: cents, maximumCents: cents }).strict().refine(x => x.maximumCents >= x.minimumCents);
export const marketplacePricingSchema = z.object({
  currency: z.literal("usd"), hostCommission: fee, guestService: fee,
  subscriptions: z.array(z.object({ plan: z.string().min(1).max(80), monthlyCents: cents, commissionReductionBps: bps }).strict()).max(20),
  volumeTiers: z.array(z.object({ completedTrips: z.number().int().min(0), commissionReductionBps: bps }).strict()).max(30),
  jurisdictionAdjustment: z.object({ hostCommissionBps: z.number().int().min(-10000).max(10000), guestServiceFlatCents: cents }).strict(),
  protection: fee,
  processing: z.object({ fee, allocation: z.enum(["HOST", "GUEST", "PLATFORM"]) }).strict(),
  taxes: z.object({ basisPoints: bps, extrasTaxable: z.boolean(), guestServiceTaxable: z.boolean(), protectionTaxable: z.boolean(), processingTaxable: z.boolean() }).strict(),
  riskReserve: fee,
  promotions: z.object({ hostShareBps: bps }).strict(),
  settlement: z.object({ delayDays: z.number().int().min(0).max(365), refundHostBps: bps, chargebackHostBps: bps, reverseTransfers: z.boolean() }).strict(),
}).strict().refine(x => new Set(x.subscriptions.map(s => s.plan)).size === x.subscriptions.length && new Set(x.volumeTiers.map(t => t.completedTrips)).size === x.volumeTiers.length, "Duplicate plan or volume tier");
export type MarketplacePricingConfig = z.infer<typeof marketplacePricingSchema>;
const rounded = (amount: number, rate: number) => Number((BigInt(amount) * BigInt(rate) + BigInt(5000)) / BigInt(10000));
const amountFor = (base: number, rule: z.infer<typeof fee>) => Math.min(rule.maximumCents, Math.max(rule.minimumCents, rounded(base, rule.basisPoints) + rule.flatCents));

/** Pure integer-cent calculation. Inputs and every allocation are frozen with the policy. */
export function calculateMarketplacePrice(base: PricingBreakdown, input: MarketplacePricingConfig, facts: { completedTrips: number; subscriptionPlan: string | null }) {
  const config = marketplacePricingSchema.parse(input);
  if (!Number.isSafeInteger(facts.completedTrips) || facts.completedTrips < 0) throw new Error("INVALID_PRICING_FACTS");
  for (const value of [base.subtotalCents, base.extrasCents, base.discountCents, base.depositCents]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_PRICING_AMOUNT");
  const gross = base.subtotalCents + base.extrasCents;
  if (base.discountCents > gross) throw new Error("DISCOUNT_EXCEEDS_RENTAL");
  const subscription = config.subscriptions.find(s => s.plan === facts.subscriptionPlan);
  const tier = [...config.volumeTiers].sort((a,b) => b.completedTrips-a.completedTrips).find(t => facts.completedTrips >= t.completedTrips);
  const hostDiscount = rounded(base.discountCents, config.promotions.hostShareBps);
  const hostBase = gross - hostDiscount;
  const commissionRate = Math.max(0, Math.min(10000, config.hostCommission.basisPoints + config.jurisdictionAdjustment.hostCommissionBps - (subscription?.commissionReductionBps ?? 0) - (tier?.commissionReductionBps ?? 0)));
  const commission = amountFor(hostBase, {...config.hostCommission, basisPoints: commissionRate});
  const guestBase = gross - base.discountCents;
  const guestService = amountFor(guestBase, {...config.guestService, flatCents: config.guestService.flatCents + config.jurisdictionAdjustment.guestServiceFlatCents});
  const protection = amountFor(guestBase, config.protection);
  // Processing uses the explicitly frozen rental base, never a circular total-with-fees formula.
  const processing = amountFor(guestBase, config.processing.fee);
  const guestProcessing = config.processing.allocation === "GUEST" ? processing : 0;
  const hostProcessing = config.processing.allocation === "HOST" ? processing : 0;
  const platformProcessing = config.processing.allocation === "PLATFORM" ? processing : 0;
  const reserve = amountFor(hostBase, config.riskReserve);
  const hostNet = hostBase - commission - hostProcessing - reserve;
  if (hostNet < 0) throw new Error("POLICY_EXCEEDS_HOST_EARNINGS");
  const rentalTaxBase = Math.max(0, base.subtotalCents + (config.taxes.extrasTaxable ? base.extrasCents : 0) - base.discountCents);
  const rentalTax = rounded(rentalTaxBase, config.taxes.basisPoints);
  const feeTax = rounded((config.taxes.guestServiceTaxable ? guestService : 0) + (config.taxes.protectionTaxable ? protection : 0) + (config.taxes.processingTaxable ? guestProcessing : 0), config.taxes.basisPoints);
  const fees = guestService + guestProcessing + protection;
  const total = guestBase + fees + rentalTax + feeTax;
  if (!Number.isSafeInteger(total) || total > 2_000_000_000) throw new Error("PRICING_LIMIT_EXCEEDED");
  return {
    breakdown: { ...base, feesCents: fees, taxCents: rentalTax + feeTax, totalCents: total,
      marketplace: { platformFeeCents: guestService, protectionCents: protection, processingCents: guestProcessing, hostCommissionCents: commission, hostEarningsCents: hostNet, reserveCents: reserve, approval: "SAMPLE_UNAPPROVED" as const } },
    amounts: { grossCents: gross, hostDiscountCents: hostDiscount, platformDiscountCents: base.discountCents-hostDiscount, commissionCents: commission, hostNetCents: hostNet, rentalTaxCents: rentalTax, feeTaxCents: feeTax, feesCents: fees, totalCents: total,
      guestServiceCents: guestService, protectionCents: protection, guestProcessingCents: guestProcessing, hostProcessingCents: hostProcessing, platformProcessingCents: platformProcessing, riskReserveCents: reserve, depositCents: base.depositCents, extrasCents: base.extrasCents, discountCents: base.discountCents },
    facts: { ...facts, appliedCommissionBps: commissionRate, subscriptionMonthlyCents: subscription?.monthlyCents ?? 0, volumeTier: tier?.completedTrips ?? null },
  };
}

export async function marketplacePolicyQuote(tx: Prisma.TransactionClient, vehicle: Vehicle, base: PricingBreakdown): Promise<{ breakdown: PricingBreakdown; terms: FinanceTerms } | null> {
  const now = new Date();
  const policy = vehicle.jurisdictionCode ? await tx.marketplacePricingPolicy.findFirst({where: {jurisdictionCode: vehicle.jurisdictionCode, effectiveAt: {lte: now}}, orderBy: {version: "desc"}}) : null;
  if (!policy) { if (localDevelopment()) return null; throw new Error("PRICING_POLICY_NOT_RELEASED"); }
  if (policy.status !== "STAGING_READY" || !policy.reviewedAt || !policy.reviewedById || policy.endsAt && policy.endsAt <= now || !vehicle.hostId) throw new Error("PRICING_POLICY_NOT_RELEASED");
  const config = marketplacePricingSchema.parse(policy.config);
  if (fingerprint(config) !== policy.contentHash) throw new Error("PRICING_POLICY_INTEGRITY");
  const membership = await tx.hostSubscription.findUnique({where: {hostId: vehicle.hostId}});
  const subscriptionPlan = membership && membership.jurisdictionCode === vehicle.jurisdictionCode && membership.activeUntil > now ? membership.plan : null;
  const completedTrips = await tx.reservation.count({where: {vehicle: {hostId: vehicle.hostId}, status: "COMPLETED", jurisdictionCode: vehicle.jurisdictionCode}});
  const calculation = calculateMarketplacePrice(base, config, {completedTrips, subscriptionPlan});
  return {breakdown: calculation.breakdown, terms: {
    commission: {engine: "MARKETPLACE_V1", policyId: policy.id, version: policy.version, contentHash: policy.contentHash, jurisdiction: policy.jurisdictionCode, status: "SAMPLE_UNAPPROVED", config, facts: calculation.facts, calculation: calculation.breakdown},
    tax: {jurisdiction: policy.jurisdictionCode, policyId: policy.id, config: config.taxes, status: "SAMPLE_UNAPPROVED"},
    settlement: {delayDays: config.settlement.delayDays, loss: {refundHostBps: config.settlement.refundHostBps, chargebackHostBps: config.settlement.chargebackHostBps, reverseTransfers: config.settlement.reverseTransfers}},
    amounts: calculation.amounts, approved: false,
  }};
}

