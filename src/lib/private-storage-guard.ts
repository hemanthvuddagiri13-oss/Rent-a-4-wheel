import type {PrismaClient} from "@prisma/client";
import {createSafePrismaClient} from "@/lib/prisma";
/** A physical connection fences upload against logical and physical deletion. */
export async function withPrivateStorageGuard<T>(key:string,run:(db:PrismaClient)=>Promise<T>):Promise<T>{
 const url=new URL(process.env.DIRECT_DATABASE_URL||process.env.DATABASE_URL!);
 if(url.searchParams.get("pgbouncer")==="true")throw new Error("PRIVATE_STORAGE_DIRECT_SESSION_REQUIRED");
 url.searchParams.set("connection_limit","1");url.searchParams.set("pool_timeout","15");
 const db=createSafePrismaClient(url.toString());let held=false;
 try{await db.$connect();await db.$executeRawUnsafe("SET lock_timeout='12s'");await db.$queryRaw`SELECT pg_advisory_lock(hashtextextended(${"private:"+key},0))::text`;held=true;return await run(db);}
 finally{try{if(held)await db.$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${"private:"+key},0))`;}finally{await db.$disconnect();}}
}
