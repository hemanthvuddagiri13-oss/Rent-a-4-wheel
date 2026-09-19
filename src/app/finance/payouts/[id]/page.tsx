import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hostFinancePage,adminFinancePage } from "@/lib/finance-page-access";
import { money } from "@/lib/finance-access";
import { FinanceWorkspace,FinanceRestricted,FinanceStatus } from "@/components/marketplace/finance-workspace";
import { Panel } from "@/components/marketplace/workspace";
import { ActionForm } from "@/components/marketplace/action-form";
export default async function PayoutPage({params}:{params:Promise<{id:string}>}){
 const [context,admin]=await Promise.all([hostFinancePage(),adminFinancePage()]);if(!context&&!admin)return <FinanceRestricted/>;
 const {id}=await params,b=await prisma.payoutBatch.findFirst({where:{id,...(!admin?{hostId:context!.host.id}:{})}});if(!b)notFound();
 const account=await prisma.connectAccount.findUnique({where:{hostId:b.hostId}});
 const review=await prisma.financialOperation.count({where:{payload:{path:["batchId"],equals:b.id},state:"REVIEW"}});
 const [items,reversals]=await Promise.all([prisma.payoutItem.findMany({where:{batchId:id}}),prisma.payoutReversal.findMany({where:{batchId:id},orderBy:{createdAt:"desc"}})]);
 return <FinanceWorkspace title="Payout details" admin={Boolean(admin)} description="A reserved batch stays linked to its original earnings through provider recovery, failure and reversal.">
  <Panel title={money(b.amountCents,b.currency)}><FinanceStatus value={b.state}/><p className="mt-5 break-all text-sm text-silver">Batch {b.id}</p><p className="mt-3 text-silver">{b.reason??"Provider confirmation determines delivery. A scheduled or pending payout is not a completed bank payment."}</p><dl className="mt-6 grid gap-4 sm:grid-cols-3">{[["Paid to bank",b.paidCents],["Transferred",b.transferredCents],["Reversed",b.reversedCents],["Reserved for reversal",b.reversalReservedCents]].map(([label,value])=><div key={label}><dt className="text-sm text-silver">{label}</dt><dd className="mt-1 text-xl text-white">{money(Number(value),b.currency)}</dd></div>)}</dl></Panel>
  {!["PAID","REVERSED","VOIDED"].includes(b.state)&&(review||!account?.active||!account.payoutsEnabled||account.verificationStatus!=="VERIFIED")?<Panel title="Payout requires action"><p className="text-silver">{review?"The provider outcome needs finance reconciliation. This batch will not be sent again without verified evidence.":"The connected account needs verification or an authorized account review before new payout movement."}</p><Link href={admin?"/finance/admin/reconciliation":"/finance/onboarding"} className="mt-4 inline-block text-gold-bright">{admin?"Open reconciliation":"Open payout settings"} →</Link></Panel>:null}
  <Panel title="Included earnings"><div className="divide-y divide-white/10">{items.map(i=><div key={i.id} className="flex flex-wrap justify-between gap-3 py-4 text-sm"><span className="break-all text-silver">Reservation {i.reservationId}</span><span className="text-white">{money(i.amountCents,b.currency)}</span></div>)}</div></Panel>
  {reversals.length>0&&<Panel title="Transfer recovery">{reversals.map(r=><div key={r.id} className="space-y-2 border-b border-white/10 py-4"><FinanceStatus value={r.state}/><p className="text-white">{money(r.amountCents,b.currency)}</p><p className="text-sm text-silver">{r.reason}</p></div>)}</Panel>}
  {admin?.role==="SUPER_ADMIN"&&b.transferredCents===0&&b.state!=="VOIDED"&&<Panel title="Void an undispatched batch"><ActionForm endpoint="/api/finance" action="stepUp" label="Send finance verification code"/><div className="mt-5"><ActionForm endpoint="/api/finance" action="voidBatch" values={{id}} fields={[{name:"stepUpCode",label:"Fresh finance verification code"},{name:"reason",label:"Reason",type:"textarea"}]} label="Verify no dispatch and release earnings"/></div></Panel>}
  <Panel title="Payout statement"><ActionForm endpoint="/api/finance" action="document" values={{kind:"PAYOUT_STATEMENT",batchId:id}} label="Issue private PDF" redirectTo="/api/finance/documents/:id"/></Panel>
  {admin?.role==="SUPER_ADMIN"&&b.state==="PAYOUT_FAILED"&&<Panel title="Retry confirmed failure"><p className="mb-5 text-silver">A new generation is allowed only after Stripe confirms failure or cancellation. The original transfer is retained.</p><ActionForm endpoint="/api/finance" action="stepUp" label="Send finance verification code"/><div className="mt-5"><ActionForm endpoint="/api/finance" action="retryPayout" values={{id}} fields={[{name:"stepUpCode",label:"Finance verification code",max:999999}]} label="Authorize retry"/></div></Panel>}
 </FinanceWorkspace>;
}
