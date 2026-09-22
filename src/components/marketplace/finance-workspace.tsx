import Link from "next/link";
import type { ReactNode } from "react";
import { Workspace, Panel } from "./workspace";
import { WorkspaceNavigation } from "@/components/layout/workspace-navigation";

export function FinanceWorkspace({title,description,children,admin=false}:{title:string;description?:string;children:ReactNode;admin?:boolean}) {
 const links=(admin?[["/finance/admin","Overview"],["/finance/admin/rules","Commission & tax rules"],["/finance/admin/reconciliation","Reconciliation"]]:[["/finance","Earnings"],["/finance/onboarding","Payout settings"],["/finance/statements","Statements"],["/host","Host workspace"]]).map(([href,label])=>({href,label}));
 return <Workspace eyebrow={admin?"Financial administration":"Host finance"} title={title} description={description}>
  <WorkspaceNavigation label="Finance" links={links} />
  <p className="rounded-xl border border-gold/30 bg-gold/5 p-4 text-sm text-silver"><strong className="text-gold-bright">Development sandbox.</strong> Live transfers and payouts are disabled. Availability and bank delivery depend on approved policies and Stripe confirmation.</p>
  {children}
 </Workspace>;
}
export function FinanceRestricted(){return <Workspace eyebrow="Private financial information" title="Finance access required"><Panel title="This workspace is restricted"><p className="text-silver">Sign in as an approved host owner, an employee with explicit finance permission, or an authorized finance administrator.</p><Link href="/host" className="mt-5 inline-block text-gold-bright">Return to host workspace →</Link></Panel></Workspace>;}
export function FinanceStatus({value}:{value:string}){return <span className="inline-flex max-w-full break-words rounded-full border border-gold/25 bg-gold/5 px-3 py-1 text-xs font-medium text-gold-bright">{value.replaceAll("_"," ")}</span>;}
export function FinanceEmpty({children}:{children:ReactNode}){return <p className="rounded-xl border border-dashed border-white/15 p-6 text-sm leading-6 text-silver">{children}</p>;}
