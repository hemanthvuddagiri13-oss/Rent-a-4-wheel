import { beforeAll,afterAll,expect,it,vi } from "vitest";
import { createServer,type Server } from "node:http";
import { prisma,createTestCustomer,createTestVehicle,createTestReservation } from "./helpers/factories";
const identity=vi.hoisted(()=>({id:""}));
vi.mock("@/auth",()=>({auth:async()=>identity.id?{user:{id:identity.id}}:null}));
import { POST } from "@/app/api/finance/route";
import { POST as cron } from "@/app/api/cron/payouts/[worker]/route";
let server:Server,base:string;const users:string[]=[];
beforeAll(async()=>{server=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const request=new Request(base+req.url,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(","):v??""])),...(req.method==="POST"?{body:Buffer.concat(chunks)}:{})});const result=req.url?.startsWith("/cron/")?await cron(request,{params:Promise.resolve({worker:req.url.slice(6)})}):await POST(request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch{res.writeHead(500);res.end();}});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base="http://127.0.0.1:"+(server.address() as {port:number}).port;vi.stubEnv("AUTH_URL",base);vi.stubEnv("CRON_SECRET","finance-http-only-secret");});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.user.deleteMany({where:{id:{in:users}}});await prisma.$disconnect();vi.unstubAllEnvs();});
const post=(body:unknown,origin=base)=>fetch(base+"/api/finance",{method:"POST",headers:{"Content-Type":"application/json",origin},body:JSON.stringify(body)});
it("HTTP finance routes require sign-in and matching origin before mutation",async()=>{identity.id="";expect((await post({action:"batch"})).status).toBe(401);const user=await createTestCustomer();users.push(user.id);identity.id=user.id;expect((await post({action:"batch"},"https://untrusted.example")).status).toBe(403);expect((await post({action:"stepUp"})).status).toBe(403);expect((await post({action:"onboarding",hostId:"someone-else",accountId:"acct_attacker",amount:1})).status).toBe(404);});
it.each(["accounting","recovery","schedule","reconciliation","historical-audit"])("HTTP cron %s rejects missing and incorrect credentials",async worker=>{for(const authorization of ["","Bearer incorrect"]){const r=await fetch(base+"/cron/"+worker,{method:"POST",headers:{authorization}});expect(r.status).toBe(401);}});
it("HTTP cron rejects unknown work even with valid authentication",async()=>{expect((await fetch(base+"/cron/not-a-worker",{method:"POST",headers:{authorization:"Bearer finance-http-only-secret"}})).status).toBe(404);});
it("HTTP rule approval cannot elevate an ordinary administrator",async()=>{const admin=await createTestCustomer({role:"ADMIN"});users.push(admin.id);identity.id=admin.id;const r=await post({action:"rule",kind:"COMMISSION",scope:"DEFAULT",scopeId:"*",effectiveAt:"2049-01-01T00:00:00Z",approve:"yes",stepUpCode:"123456",basisPoints:1000,fixedCents:0,minimumCents:0,maximumCents:100000,hostDiscountBps:0});expect(r.status).toBe(403);expect(await prisma.financeRule.count({where:{createdById:admin.id}})).toBe(0);});

it("authenticated HTTP accounting cron exposes persisted review from the real database worker",async()=>{
 // The shared database contains retained financial fixtures. Authentication
 // never guarantees 200: explicit unresolved evidence must remain actionable.
 const customer=await createTestCustomer(),vehicle=await createTestVehicle();
 const reservation=await createTestReservation({vehicleId:vehicle.id,customerId:customer.id,pickupAt:new Date("2056-01-01"),returnAt:new Date("2056-01-02"),status:"COMPLETED"});
 const issue=await prisma.financeIssue.create({data:{key:"http-accounting-review:"+reservation.id,reservationId:reservation.id,kind:"PAYMENT_DIFFERENCE",reason:"Persisted unmatched payment requires independent review"}});
 try{
  const response=await fetch(base+"/cron/accounting",{method:"POST",headers:{authorization:"Bearer finance-http-only-secret"}});
  expect(response.status).toBe(503);
  const result=await response.json();
  expect(result.worker.review).toBeGreaterThanOrEqual(1);
  expect(result.worker.actionable).toBe(result.worker.review+result.worker.failed);
  expect(result.processed).toBe(result.worker.committed);
  expect(result.worker.status).toBe(result.worker.committed>0?"PARTIAL_FAILURE":"FAILED");
  expect(await prisma.financeIssue.findUnique({where:{id:issue.id}})).toEqual(issue);
  expect(await prisma.ledgerJournal.count({where:{reservationId:reservation.id}})).toBe(0);
  expect(await prisma.reservation.findUnique({where:{id:reservation.id}})).toEqual(reservation);
 }finally{await prisma.financeIssue.delete({where:{id:issue.id}});}
});
