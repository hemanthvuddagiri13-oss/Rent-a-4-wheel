import type {OperationsJob,Prisma} from "@prisma/client";
import {prisma} from "@/lib/prisma";
export class OperationsLeaseLost extends Error {constructor(){super("OPERATIONS_LEASE_LOST");}}
export async function assertOperationsLease(tx:Prisma.TransactionClient,job:OperationsJob){
 const rows=await tx.$queryRaw<Array<{key:string}>>`SELECT key FROM "OperationsJob" WHERE key=${job.key} AND state='RUNNING' AND "leaseToken"=${job.leaseToken} AND "leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE`;
 if(!rows.length)throw new OperationsLeaseLost();
}
export async function finishOperation(job:OperationsJob,state:"DONE"|"RETRY"|"REVIEW",error?:string,db:Prisma.TransactionClient=prisma){
 const delay=Math.min(3600000,60000*2**job.attempts);
 const count=await db.$executeRaw`UPDATE "OperationsJob" SET state=${state},"leaseToken"=NULL,"leaseExpiresAt"=NULL,"lastErrorCode"=${error??null},"nextAttemptAt"=(clock_timestamp() AT TIME ZONE 'UTC')+${delay}*interval '1 millisecond',"updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') WHERE key=${job.key} AND state='RUNNING' AND "leaseToken"=${job.leaseToken} AND "leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`;
 return {count};
}
