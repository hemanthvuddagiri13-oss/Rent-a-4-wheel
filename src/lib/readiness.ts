import { prisma,createSafePrismaClient } from "@/lib/prisma";
import { productionConfiguration } from "@/lib/production-config";
import { localDevelopment } from "@/lib/deployment-environment";
import { verifyPrivateBucket } from "@/lib/s3-private";
import { scannerVersion } from "@/lib/clamav";
export async function databaseReady(){
 await prisma.$queryRaw`SELECT 1`;
 const extension=await prisma.$queryRaw<Array<{extname:string}>>`SELECT extname FROM pg_extension WHERE extname='btree_gist'`;if(!extension.length)return false;
 const address=process.env.DIRECT_DATABASE_URL??(localDevelopment()?process.env.DATABASE_URL:undefined);if(!address)return false;
 const url=new URL(address);url.searchParams.set("connection_limit","1");url.searchParams.set("connect_timeout","5");const db=createSafePrismaClient(url.toString());
 try{await db.$connect();const first=await db.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;const lock="readiness:"+crypto.randomUUID();await db.$queryRaw`SELECT pg_advisory_lock(hashtextextended(${lock},0))::text`;const second=await db.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;const released=await db.$queryRaw<Array<{ok:boolean}>>`SELECT pg_advisory_unlock(hashtextextended(${lock},0)) AS ok`;return first[0].pid===second[0].pid&&released[0].ok;}finally{await db.$disconnect();}
}
export async function readiness(){const configuration=productionConfiguration();if(!configuration.ready)return false;try{if(!await databaseReady())return false;if(!localDevelopment()){await verifyPrivateBucket();await scannerVersion();}return true;}catch{return false;}}
