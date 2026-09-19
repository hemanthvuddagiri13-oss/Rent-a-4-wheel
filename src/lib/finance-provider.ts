import Stripe from "stripe";
import type { FinancialOperation } from "@prisma/client";
import { requireFinanceSandbox } from "@/lib/payout-authority";
import { OperationPendingError } from "@/lib/financial-errors";

export type FinanceProviderObject={id:string;operationKey:string;kind:string;hostId:string;accountId:string;status:string;amount:number;currency:string;amountReversed:number;detailsSubmitted?:boolean;chargesEnabled?:boolean;payoutsEnabled?:boolean;currentlyDue?:string[];eventuallyDue?:string[];disabledReason?:string|null};
export type FinancePayload={hostId:string;batchId?:string;accountId?:string;amount?:number;currency?:string;transferId?:string;reversalId?:string;metadata?:Record<string,string>};
export function financeStripe(){requireFinanceSandbox();return new Stripe(process.env.STRIPE_SECRET_KEY!,{timeout:8000,maxNetworkRetries:0});}
export function accountProjection(a:Stripe.Account):FinanceProviderObject {return {id:a.id,operationKey:a.metadata?.operationKey??"",kind:"FINANCE_CONNECT",hostId:a.metadata?.hostId??"",accountId:a.id,status:a.payouts_enabled&&a.details_submitted&&!a.requirements?.disabled_reason?"verified":"requires_action",amount:0,currency:a.default_currency??"usd",amountReversed:0,detailsSubmitted:a.details_submitted,chargesEnabled:a.charges_enabled,payoutsEnabled:a.payouts_enabled,currentlyDue:a.requirements?.currently_due??[],eventuallyDue:a.requirements?.eventually_due??[],disabledReason:a.requirements?.disabled_reason??null};}
function transferProjection(t:Stripe.Transfer):FinanceProviderObject{return{id:t.id,operationKey:t.metadata.operationKey??"",kind:"FINANCE_TRANSFER",hostId:t.metadata.hostId??"",accountId:typeof t.destination==="string"?t.destination:t.destination?.id??"",status:t.reversed?"reversed":"transferred",amount:t.amount,currency:t.currency,amountReversed:t.amount_reversed};}
function payoutProjection(p:Stripe.Payout,accountId:string):FinanceProviderObject{return{id:p.id,operationKey:p.metadata?.operationKey??"",kind:"FINANCE_PAYOUT",hostId:p.metadata?.hostId??"",accountId,status:p.status,amount:p.amount,currency:p.currency,amountReversed:0};}
function reversalProjection(r:Stripe.TransferReversal,p:FinancePayload):FinanceProviderObject{return{id:r.id,operationKey:r.metadata?.operationKey??"",kind:"FINANCE_REVERSAL",hostId:r.metadata?.hostId??"",accountId:p.accountId!,status:"reversed",amount:r.amount,currency:r.currency,amountReversed:r.amount};}
export async function createFinanceProviderObject(op:FinancialOperation,key:string){
 const stripe=financeStripe(),p=op.payload as FinancePayload,metadata={hostId:p.hostId,operationKey:key,...(p.batchId?{batchId:p.batchId}:{})};
 if(op.kind==="FINANCE_CONNECT")return accountProjection(await stripe.accounts.create({country:process.env.STRIPE_CONNECT_COUNTRY??"US",controller:{fees:{payer:"application"},losses:{payments:"application"},stripe_dashboard:{type:"express"},requirement_collection:"stripe"},capabilities:{transfers:{requested:true}},settings:{payouts:{schedule:{interval:"manual"}}},metadata},{idempotencyKey:key}));
 if(op.kind==="FINANCE_TRANSFER")return transferProjection(await stripe.transfers.create({amount:p.amount!,currency:p.currency!,destination:p.accountId!,transfer_group:p.batchId,metadata},{idempotencyKey:key}));
 if(op.kind==="FINANCE_PAYOUT")return payoutProjection(await stripe.payouts.create({amount:p.amount!,currency:p.currency!,metadata},{stripeAccount:p.accountId,idempotencyKey:key}),p.accountId!);
 if(op.kind==="FINANCE_REVERSAL")return reversalProjection(await stripe.transfers.createReversal(p.transferId!,{amount:p.amount,metadata},{idempotencyKey:key}),p);
 throw new Error("Unsupported finance provider operation");
}
export async function retrieveFinanceProviderObject(op:FinancialOperation,id:string){
 const stripe=financeStripe(),p=op.payload as FinancePayload;
 if(op.kind==="FINANCE_CONNECT")return accountProjection(await stripe.accounts.retrieve(id));
 if(op.kind==="FINANCE_TRANSFER")return transferProjection(await stripe.transfers.retrieve(id));
 if(op.kind==="FINANCE_PAYOUT")return payoutProjection(await stripe.payouts.retrieve(id,{}, {stripeAccount:p.accountId}),p.accountId!);
 if(op.kind==="FINANCE_REVERSAL")return reversalProjection(await stripe.transfers.retrieveReversal(p.transferId!,id),p);
 throw new Error("Unsupported finance provider operation");
}
export async function discoverFinanceProviderObject(op:FinancialOperation){
 const stripe=financeStripe(),p=op.payload as FinancePayload,found:FinanceProviderObject[]=[];
 // Discovery only accepts exact immutable metadata; absence is not permission to
 // replay a dispatched request, even inside Stripe's idempotency retention window.
 if(op.kind==="FINANCE_CONNECT"){for await(const a of stripe.accounts.list({limit:100}))if(a.metadata?.operationKey===op.key&&a.metadata.hostId===p.hostId)found.push(accountProjection(a));}
 else if(op.kind==="FINANCE_TRANSFER"){for await(const t of stripe.transfers.list({transfer_group:p.batchId,limit:100}))if(t.metadata.operationKey===op.key&&t.metadata.hostId===p.hostId)found.push(transferProjection(t));}
 else if(op.kind==="FINANCE_PAYOUT"){for await(const t of stripe.payouts.list({limit:100},{stripeAccount:p.accountId}))if(t.metadata?.operationKey===op.key&&t.metadata.hostId===p.hostId)found.push(payoutProjection(t,p.accountId!));}
 else if(op.kind==="FINANCE_REVERSAL"){for await(const t of stripe.transfers.listReversals(p.transferId!,{limit:100}))if(t.metadata?.operationKey===op.key&&t.metadata.hostId===p.hostId)found.push(reversalProjection(t,p));}
 if(found.length>1)throw new Error("Multiple provider objects match one finance operation");return found[0]??null;
}
export async function createOnboardingLink(accountId:string){const stripe=financeStripe(),base=process.env.AUTH_URL??process.env.NEXTAUTH_URL;if(!base)throw new Error("Canonical application URL required");return stripe.accountLinks.create({account:accountId,type:"account_onboarding",refresh_url:new URL("/finance/onboarding?refresh=1",base).toString(),return_url:new URL("/finance/onboarding?returned=1",base).toString()});}
export async function retrieveConnectAccount(id:string){return accountProjection(await financeStripe().accounts.retrieve(id));}

// Read under the existing pinned dispatch guard, before recording DISPATCHED.
// A temporary balance/requirements failure therefore remains safely retryable.
export async function verifyFinanceDestination(op:FinancialOperation){
 const p=op.payload as FinancePayload,stripe=financeStripe();
 if(!["FINANCE_TRANSFER","FINANCE_PAYOUT"].includes(op.kind))return;
 const a=await stripe.accounts.retrieve(p.accountId!);
 if(a.id!==p.accountId||a.metadata?.hostId!==p.hostId||!a.payouts_enabled||!a.details_submitted||a.requirements?.disabled_reason||a.settings?.payouts?.schedule?.interval!=="manual")throw new OperationPendingError("Stripe account ownership, manual payout control or verification requires action");
 const balance=op.kind==="FINANCE_PAYOUT"?await stripe.balance.retrieve({},{stripeAccount:p.accountId}):await stripe.balance.retrieve();
 if(!balance.available.some(b=>b.currency===p.currency&&b.amount>=(p.amount??0)))throw new OperationPendingError("Stripe available balance is below the immutable payout amount");
}
