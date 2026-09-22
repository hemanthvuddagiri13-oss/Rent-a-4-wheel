import type { FinanceTerms } from "@/lib/finance-rules";

/** Cumulative allocation avoids rounding drift across partial refunds. All caps are frozen amounts. */
export function marketplaceRefundAllocation(amounts: FinanceTerms["amounts"], cash: number, paid: number, refundHostBps: number, hostEntitlement: number) {
  if (!Number.isSafeInteger(cash) || !Number.isSafeInteger(paid) || cash < 0 || paid <= 0 || cash > paid) throw new Error("INVALID_REFUND_ALLOCATION");
  const prorate = (value: number) => Number(BigInt(cash) * BigInt(value) / BigInt(paid));
  const discount = prorate(amounts.platformDiscountCents);
  let remaining = paid + amounts.platformDiscountCents;
  const take = (value: number) => {const allocated = Math.min(remaining, Math.max(0, value)); remaining -= allocated; return allocated;};
  const tax = take(amounts.rentalTaxCents + amounts.feeTaxCents);
  const protection = take(amounts.protectionCents ?? 0);
  const reserve = take(amounts.riskReserveCents ?? 0);
  const host = take(Math.min(Math.max(0,hostEntitlement), Number((BigInt(amounts.hostNetCents)*BigInt(refundHostBps)+BigInt(5000))/BigInt(10000))));
  const platformFees = take(amounts.commissionCents + (amounts.guestServiceCents ?? 0));
  // Processing liabilities remain payable. Any unrecovered processing and platform-funded promotion is platform cost.
  const weights={tax,protection,reserve,host,platformFees,platformCost:remaining};
  const keys=Object.keys(weights) as Array<keyof typeof weights>,total=paid+amounts.platformDiscountCents,budget=cash+discount;
  // Jefferson highest averages is house-monotonic. Start at its lower quotas,
  // then assign the remaining cents using exact rational comparisons.
  // Independent rounded shares (or largest remainders) can move pennies backwards.
  const result={...weights};
  for(const key of keys)result[key]=Number(BigInt(budget)*BigInt(weights[key])/BigInt(total));
  let unassigned=budget-keys.reduce((n,key)=>n+result[key],0);
  while(unassigned-->0){let chosen=keys[0];for(const key of keys)if(BigInt(weights[key])*BigInt(result[chosen]+1)>BigInt(weights[chosen])*BigInt(result[key]+1))chosen=key;result[chosen]++;}
  return {...result,discount};
}

export type RefundAllocation = ReturnType<typeof marketplaceRefundAllocation>;
export const emptyRefundAllocation = (): RefundAllocation => ({tax:0,protection:0,reserve:0,host:0,platformFees:0,platformCost:0,discount:0});

/** Later adjustments can limit new recovery, but cannot rewrite posted cents.
 * The original snapshot fixes weights; unrecoverable incremental host amounts
 * become explicit platform refund cost. Host credits never enlarge those weights.
 */
export function additionalMarketplaceRefund(amounts: FinanceTerms["amounts"], cash: number, paid: number, refundHostBps: number, prior: RefundAllocation, availableHost: number) {
  const target = marketplaceRefundAllocation(amounts,cash,paid,refundHostBps,amounts.hostNetCents);
  const delta = emptyRefundAllocation();
  for (const key of Object.keys(delta) as Array<keyof RefundAllocation>) delta[key]=target[key]-prior[key];
  const incrementalBudget=cash+target.discount-(prior.tax+prior.protection+prior.reserve+prior.host+prior.platformFees+prior.platformCost);
  const recoverableBudget=incrementalBudget-delta.tax-delta.protection-delta.reserve-delta.platformFees;
  delta.host=Math.min(Math.max(0,availableHost),Math.max(0,delta.host),Math.max(0,recoverableBudget));
  // A previous host shortfall was already borne by the platform; allocate only
  // the remaining budget after the other immutable cumulative targets.
  delta.platformCost=recoverableBudget-delta.host;
  if(Object.values(delta).some(n=>!Number.isSafeInteger(n)||n<0))throw new Error("REFUND_ALLOCATION_REQUIRES_REVIEW");
  return delta;
}
