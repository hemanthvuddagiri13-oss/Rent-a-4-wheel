import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveCase } from "./actions";
export const dynamic = "force-dynamic";
export default async function FinancialCases() {
 const session=await auth(); if (!session?.user || !["ADMIN","SUPER_ADMIN"].includes(session.user.role)) return <p>Forbidden</p>;
 const viewer=await prisma.user.findUnique({where:{id:session.user.id}});
 if(!viewer?.isActive || !["ADMIN","SUPER_ADMIN"].includes(viewer.role)) return <p>Forbidden</p>;
 const cases=await prisma.financialCase.findMany({ where:{status:{not:"RESOLVED"}}, orderBy:{createdAt:"asc"},take:100 });
 const history=await prisma.auditLog.findMany({where:{entityType:"FinancialCase",entityId:{in:cases.map(c=>c.id)}},orderBy:{createdAt:"desc"},take:500});
 const failedRefunds=await prisma.refund.count({where:{status:"FAILED"}});
 const quarantined=await prisma.financialCase.count({where:{status:{in:["OPEN","MANUAL_REVIEW"]}}});
 const failedOutbox=await prisma.outboxMessage.count({where:{status:"FAILED"}});
 const counts=await prisma.financialOperation.groupBy({by:["state"],_count:true});
 const oldest=await prisma.financialOperation.findFirst({where:{state:{in:["READY","RETRY","POLL","RUNNING"]}},orderBy:{createdAt:"asc"}});
 return <main><h1>Financial reconciliation</h1><p>Quarantined/manual cases: {quarantined} · Failed refunds: {failedRefunds} · Dead-letter deliveries: {failedOutbox}</p><p>Operation counts: {counts.map(c=>c.state+": "+c._count).join(" · ")}</p><p>Oldest pending: {oldest?.createdAt.toISOString() ?? "None"}</p>
 <p>Adoption verifies Stripe identity and preserves review. Settlement requires a separate super administrator decision. Provider absence never proves failure.</p>
 {cases.map(c=><article key={c.id} className="my-6 border p-4"><h2>{c.kind} · {c.status} · {c.amountCents ?? "Unknown amount"} {c.currency ?? "Unknown currency"}</h2>
 <p>Reservation {c.reservationId} · Customer {c.customerId} · Created {c.createdAt.toISOString()} · Owner {c.assignedToId ?? "Unassigned"}</p>
 <p>{c.reason} · Attempts {c.attempts} · Last error {c.lastError ?? "None"} · Resolution {c.resolution ?? "Pending"}</p><p>Original key {c.originalKey ?? "Unknown"} · Provider {c.providerId ?? "Unknown"}</p>
 <pre>{JSON.stringify(c.evidence,null,2)}</pre><details><summary>Audit history</summary>{history.filter(a=>a.entityId===c.id).map(a=><p key={a.id}>{a.createdAt.toISOString()} · {a.actorId} · {a.action} · {JSON.stringify(a.metadata)}</p>)}</details>
 <form action={resolveCase}><input type="hidden" name="caseId" value={c.id}/><label>Action <select name="action"><option>ESCALATE</option><option>ASSIGN</option><option>ADOPT</option><option>CONFIRM_FAILURE</option><option>AUTHORIZE_SETTLEMENT</option><option>RELEASE_INVENTORY</option></select></label>
 <label>Verified provider ID <input name="providerId" defaultValue={c.providerId ?? ""}/></label><label>Assignee user ID <input name="assigneeId"/></label><label>Reason <textarea name="reason" required minLength={10}/></label><button disabled={c.status==="RESOLVED"}>Record decision</button></form>
 </article>)}</main>;
}
