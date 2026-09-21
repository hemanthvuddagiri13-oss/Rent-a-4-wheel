import { Temporal } from "@js-temporal/polyfill";
import { prisma } from "@/lib/prisma";
import { financePeriod } from "@/lib/finance-documents";
// Call only after resolving current host or finance-admin access.
export async function hostYearToDate(hostId:string,timezone="America/Chicago"){
 const year=String(Temporal.Now.zonedDateTimeISO(timezone).year),{start,end}=financePeriod(year,"YEARLY_SUMMARY",timezone);
 const [earnings,payments]=await Promise.all([
  prisma.hostEarning.groupBy({by:["currency"],where:{hostId,createdAt:{gte:start,lt:end}},_sum:{grossCents:true,netCents:true}}),
  prisma.$queryRaw<Array<{currency:string;amount:bigint}>>`SELECT j.currency,sum(l."debitCents")::bigint amount FROM "LedgerJournal" j JOIN "LedgerLine" l ON l."journalId"=j.id WHERE j."hostId"=${hostId} AND j.kind='HOST_PAYOUT' AND l.account='MEMO_CONNECT_LIABILITY' AND j."createdAt">=${start} AND j."createdAt"<${end} GROUP BY j.currency`
 ]);
 return {year,timezone,rows:[...new Set([...earnings.map(e=>e.currency),...payments.map(p=>p.currency)])].map(currency=>({currency,grossCents:earnings.find(e=>e.currency===currency)?._sum.grossCents??0,paidCents:Number(payments.find(p=>p.currency===currency)?.amount??0)}))};
}
