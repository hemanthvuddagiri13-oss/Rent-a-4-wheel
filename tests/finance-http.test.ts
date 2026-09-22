import { beforeAll,afterAll,expect,it,vi } from "vitest";
import { createServer,type Server } from "node:http";
import {execFileSync} from "node:child_process";
import {readdirSync} from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
const database=vi.hoisted(()=>({name:"finance_http_"+crypto.randomUUID().replaceAll("-","")+"_test"}));
vi.mock("@/lib/prisma",async()=>{
 const {PrismaClient}=await import("@prisma/client");const url=new URL(process.env.DIRECT_DATABASE_URL??process.env.DATABASE_URL!);url.pathname="/"+database.name;
 return {prisma:new PrismaClient({datasources:{db:{url:url.toString()}}})};
});
import {prisma} from "@/lib/prisma";
import {prepareOperation} from "@/lib/financial-operations";
const source=new URL(process.env.DIRECT_DATABASE_URL??process.env.DATABASE_URL!);
const target=new URL(source);target.pathname="/"+database.name;
const adminUrl=new URL(source);adminUrl.pathname="/postgres";
function adminSql(sql:string){execFileSync(process.env.PSQL_PATH??"psql",[adminUrl.toString(),"-q","-v","ON_ERROR_STOP=1","-c",sql],{timeout:60000,stdio:["ignore","ignore","inherit"]});}
beforeAll(async()=>{
 if(!source.pathname.endsWith("_test"))throw new Error("Disposable test database required");
 adminSql('CREATE DATABASE "'+database.name+'"');
 for(const migration of readdirSync("prisma/migrations").filter(n=>/^\d/.test(n)).sort())
  execFileSync(process.env.PSQL_PATH??"psql",[target.toString(),"-q","-v","ON_ERROR_STOP=1","-f",path.resolve("prisma/migrations",migration,"migration.sql")],{timeout:120000,stdio:["ignore","ignore","inherit"]});
},120000);
async function createTestCustomer(overrides:{role?:"ADMIN"|"SUPER_ADMIN"}={}) {return prisma.user.create({data:{email:crypto.randomUUID()+"@http.test",...overrides}});}

const identity=vi.hoisted(()=>({id:""}));
vi.mock("@/auth",()=>({auth:async()=>identity.id?{user:{id:identity.id}}:null}));
import { POST } from "@/app/api/finance/route";
import { POST as cron } from "@/app/api/cron/payouts/[worker]/route";
let server:Server,base:string;const users:string[]=[];
beforeAll(async()=>{server=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const request=new Request(base+req.url,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(","):v??""])),...(req.method==="POST"?{body:Buffer.concat(chunks)}:{})});const result=req.url?.startsWith("/cron/")?await cron(request,{params:Promise.resolve({worker:req.url.slice(6)})}):await POST(request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch{res.writeHead(500);res.end();}});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+(server.address() as {port:number}).port;vi.stubEnv("AUTH_URL",base);vi.stubEnv("CRON_SECRET","finance-http-only-secret");});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await prisma.$disconnect();adminSql('DROP DATABASE IF EXISTS "'+database.name+'" WITH (FORCE)');vi.unstubAllEnvs();});
const post=(body:unknown,origin=base)=>fetch(base+"/api/finance",{method:"POST",headers:{"Content-Type":"application/json",origin},body:JSON.stringify(body)});
it("HTTP finance routes require sign-in and matching origin before mutation",async()=>{identity.id="";expect((await post({action:"batch"})).status).toBe(401);const user=await createTestCustomer();users.push(user.id);identity.id=user.id;expect((await post({action:"batch"},"https://untrusted.example")).status).toBe(403);expect((await post({action:"stepUp"})).status).toBe(403);expect((await post({action:"onboarding",hostId:"someone-else",accountId:"acct_attacker",amount:1})).status).toBe(404);});
it.each(["accounting","recovery","schedule","reconciliation","historical-audit"])("HTTP cron %s rejects missing and incorrect credentials",async worker=>{for(const authorization of ["","Bearer incorrect"]){const r=await fetch(base+"/cron/"+worker,{method:"POST",headers:{authorization}});expect(r.status).toBe(401);}});
it("HTTP cron rejects unknown work even with valid authentication",async()=>{expect((await fetch(base+"/cron/not-a-worker",{method:"POST",headers:{authorization:"Bearer finance-http-only-secret"}})).status).toBe(404);});
it("HTTP rule approval cannot elevate an ordinary administrator",async()=>{const admin=await createTestCustomer({role:"ADMIN"});users.push(admin.id);identity.id=admin.id;const r=await post({action:"rule",kind:"COMMISSION",scope:"DEFAULT",scopeId:"*",effectiveAt:"2049-01-01T00:00:00Z",approve:"yes",stepUpCode:"123456",basisPoints:1000,fixedCents:0,minimumCents:0,maximumCents:100000,hostDiscountBps:0});expect(r.status).toBe(403);expect(await prisma.financeRule.count({where:{createdById:admin.id}})).toBe(0);});

it("authenticated HTTP accounting cron attributes one review and authorized resolution to its isolated fixture",async()=>{
 const customer=await createTestCustomer(),admin=await createTestCustomer({role:"SUPER_ADMIN"});
 const id=crypto.randomUUID();
 const vehicle=await prisma.vehicle.create({data:{slug:id,vin:id,licensePlate:id,year:2024,make:"HTTP",model:"Fixture",category:"SEDAN",dailyRateCents:10000,weeklyRateCents:50000,monthlyRateCents:100000}});
 const reservation=await prisma.reservation.create({data:{confirmationNumber:id,vehicleId:vehicle.id,customerId:customer.id,pickupAt:new Date("2056-01-01"),returnAt:new Date("2056-01-02"),status:"COMPLETED",rateType:"DAILY",rateAmountCents:10000,units:1,subtotalCents:10000,totalCents:10000}});
 const op=await prepareOperation(prisma,{key:"http-undispatched:"+id,kind:"FINANCE_CONNECT",reservationId:reservation.id,payload:{hostId:"http-fixture-host"}});
 await prisma.financialOperation.update({where:{id:op.id},data:{state:"REVIEW"}});
 const issue=await prisma.financeIssue.create({data:{key:"http-accounting-review:"+reservation.id,reservationId:reservation.id,operationId:op.id,kind:"PROVIDER_UNCERTAIN",reason:"Configuration failed before any provider dispatch"}});
 const invoke=()=>fetch(base+"/cron/accounting",{method:"POST",headers:{authorization:"Bearer finance-http-only-secret"}});
 for(let replay=0;replay<2;replay++) {
  const response=await invoke();expect(response.status).toBe(503);
  expect((await response.json()).worker).toMatchObject({committed:0,review:1,failed:0,skipped:0,actionable:1,status:"FAILED"});
  expect(await prisma.financeIssue.findMany()).toEqual([issue]);
 }
 identity.id=admin.id;
 await prisma.authCode.create({data:{email:admin.email,purpose:"FINANCE_STEP_UP",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
 const resolution=await post({action:"resolve",id:issue.id,stepUpCode:"123456",reason:"Corrected configuration of the verified undispatched operation"});
 expect(resolution.status,await resolution.text()).toBe(200);
 for(let replay=0;replay<2;replay++) {
  const response=await invoke();expect(response.status).toBe(200);
  expect((await response.json()).worker).toMatchObject({committed:0,review:0,failed:0,skipped:1,actionable:0,status:"NO_WORK"});
 }
 expect(await prisma.financeIssue.count()).toBe(1);
 expect(await prisma.financeIssue.findUnique({where:{id:issue.id}})).toMatchObject({status:"RESOLVED",resolvedById:admin.id});
 expect(await prisma.auditLog.count({where:{actorId:admin.id,action:"finance.undispatched.resumed",entityId:op.id}})).toBe(1);
 expect(await prisma.accountingCheckpoint.count()).toBe(1);
 expect((await prisma.accountingCheckpoint.findUniqueOrThrow({where:{reservationId:reservation.id}})).fingerprint).not.toBe("INCOMPLETE");
 expect(await prisma.ledgerJournal.count()).toBe(0);
 expect(await prisma.payment.count()).toBe(0);expect(await prisma.payoutBatch.count()).toBe(0);
 expect(await prisma.financialDispatch.count()).toBe(0);
 expect(await prisma.reservation.findUnique({where:{id:reservation.id}})).toEqual(reservation);
});
