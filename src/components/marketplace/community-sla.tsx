import { prisma } from "@/lib/prisma";
import { isOperator } from "@/lib/collaboration-access";
import { Panel } from "./workspace";
export async function CommunitySla({role}:{role:string}) {
 const kinds=(["CLAIM","DISPUTE","INCIDENT","TICKET"] as const).filter(k=>isOperator(role,k));
 const scope={kind:{in:kinds}}, active={...scope,state:{notIn:["CLOSED","RESOLVED","DECIDED"]}};
 const since=new Date(new Date().getTime()-30*86400000);
 const response={case:scope,createdAt:{gte:since},action:"OPERATOR_REPLY",deadlineAt:{not:null}};
 const [groups,overdue,safety,replies,timely,rating]=await Promise.all([
  prisma.serviceCase.groupBy({by:["kind","state"],where:scope,_count:true}),
  prisma.serviceCase.count({where:{...active,dueAt:{lt:new Date()}}}),
  prisma.serviceCase.count({where:{...scope,safetyBlock:true}}),
  prisma.serviceCaseEvent.count({where:response}),
  prisma.serviceCaseEvent.count({where:{...response,deadlineAt:{gte:prisma.serviceCaseEvent.fields.createdAt}}}),
  prisma.serviceCase.aggregate({where:{...scope,closedAt:{gte:since},satisfaction:{not:null}},_avg:{satisfaction:true},_count:true})
 ]);
 return <Panel title="Operational reporting"><p className="mb-3 text-silver">All cases within your assigned role: {overdue} overdue response deadlines · {safety} active safety blocks.</p><p className="mb-4 text-sm text-silver">Last 30 days: {timely} of {replies} recorded operator replies met the deadline in effect when sent. Closed-ticket feedback: {rating._avg.satisfaction?.toFixed(1) ?? "No ratings"}{rating._count ? " / 5 ("+rating._count+" responses)" : ""}. This measures recorded replies, not a promised service guarantee.</p><div className="grid gap-2 sm:grid-cols-2">{groups.map(g=><p key={g.kind+g.state} className="text-sm">{g.kind} · {g.state.replaceAll("_"," ")}: {g._count}</p>)}</div></Panel>;
}
