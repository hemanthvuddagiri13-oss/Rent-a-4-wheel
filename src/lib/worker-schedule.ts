import {prisma} from "@/lib/prisma";
// Operational thresholds, not legal response deadlines. A never-run worker is
// actionable immediately when an operator starts the monitoring schedule.
export const WORKER_STALENESS_MINUTES:Record<string,number>={
 "expire-holds":5,"financial/stripe-events":5,"financial/refunds":5,
 "financial/deposits":10,"financial/reconciliation":10,"financial/historical-audit":60,
 "financial/outbox":5,"payouts/accounting":10,"payouts/recovery":10,
 "payouts/schedule":20,"payouts/reconciliation":20,"payouts/historical-audit":60,
 "community":10,"operations/scan":10,"operations/delete":15,"operations/agreements":10,
};
export async function staleWorkerCount(){
 const rows=await prisma.operationalEvent.groupBy({by:["source"],where:{category:{in:["CRON_COMPLETE","CRON_IDLE"]},source:{in:Object.keys(WORKER_STALENESS_MINUTES)}},_max:{createdAt:true}});
 return Object.entries(WORKER_STALENESS_MINUTES).filter(([source,minutes])=>{const last=rows.find(row=>row.source===source)?._max.createdAt;return !last||last.getTime()<Date.now()-minutes*60000;}).length;
}
