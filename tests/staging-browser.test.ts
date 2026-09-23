import {beforeAll,afterAll,it,expect} from "vitest";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {chromium,type Browser} from "playwright";
import {encode} from "next-auth/jwt";
import {createDeviceSession} from "@/lib/device-sessions";
import {createTestCustomer,createTestHost,createTestVehicle,createTestReservation,prisma} from "./helpers/factories";
import bcrypt from "bcryptjs";

// This suite runs against the production build only after CI provisions disposable TLS.
// Deliberately unavailable external providers prove fail-closed readiness, not provider health.
const enabled=process.env.STAGING_BROWSER==="true",base="https://localhost:3210",secret=randomBytes(48).toString("hex"),cron=randomBytes(48).toString("hex");
let child:ChildProcess,browser:Browser;const users:string[]=[];
beforeAll(async()=>{
 if(!enabled)return;
 if(!process.env.CI_TLS_CERT||!process.env.CI_TLS_KEY)throw new Error("Explicit staging TLS fixture is required");
 const database=new URL(process.env.DATABASE_URL!);database.searchParams.set("sslmode","require");database.searchParams.set("sslaccept","strict");database.searchParams.set("sslcert",process.env.CI_TLS_CERT);
 const env:NodeJS.ProcessEnv={...process.env,APP_ENV:"staging",NODE_ENV:"production",STAGING_TEST_PORT:"3210",BROWSER_TEST_PORT:"",DATABASE_URL:database.toString(),DIRECT_DATABASE_URL:database.toString(),SITE_URL:base,AUTH_URL:base,NEXTAUTH_URL:base,NEXT_PUBLIC_SITE_URL:base,PRIMARY_DOMAIN:"localhost",AUTH_SECRET:secret,AUTH_TRUST_HOST:"true",CRON_SECRET:cron,STRIPE_SECRET_KEY:"sk_test_fixture",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"pk_test_fixture",STRIPE_WEBHOOK_SECRET:"whsec_fixture",STRIPE_CONNECT_COUNTRY:"US",RESEND_API_KEY:"re_fixture",EMAIL_FROM:"Staging <staging@renta4wheel.com>",PRIVATE_STORAGE_PROVIDER:"s3",PRIVATE_STORAGE_ENV:"staging",PRIVATE_STORAGE_BUCKET:"isolated-staging",PRIVATE_STORAGE_REGION:"us-east-1",PRIVATE_STORAGE_ENDPOINT:"https://localhost:1",PRIVATE_STORAGE_KMS_KEY_ID:"arn:aws:kms:us-east-1:000000000000:key/synthetic",PRIVATE_STORAGE_ACCESS_KEY_ID:"synthetic",PRIVATE_STORAGE_SECRET_ACCESS_KEY:"synthetic",CLAMAV_HOST:"localhost",CLAMAV_PORT:"1",CLAMAV_TLS:"true",RATE_LIMIT_STORE:"postgres",MONITORING_ALERT_URL:"https://localhost:1",MONITORING_ALERT_SECRET:randomBytes(48).toString("hex"),DEPLOYMENT_DATA_ENV:"staging",PROVIDER_ACCOUNT_ENV:"staging",ALLOW_DEV_PAYMENT_SIMULATION:"false",ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV:"false",LOCAL_BUILD_WORKER_THREADS:"false",NODE_EXTRA_CA_CERTS:process.env.CI_TLS_CERT};
 child=spawn(process.execPath,["tests/helpers/staging-server.mjs"],{stdio:"inherit",env});
 browser=await chromium.launch({headless:true});const probe=await browser.newContext({ignoreHTTPSErrors:true});
 let ready=false;for(let i=0;i<120;i++){if(child.exitCode!==null)throw new Error("Staging server exited");try{if((await probe.request.get(base+"/api/health/live")).ok()){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}await probe.close();if(!ready)throw new Error("Staging production build unavailable");await mkdir("test-artifacts/staging",{recursive:true});
},90000);
afterAll(async()=>{if(!enabled)return;await browser?.close();if(child&&child.exitCode===null){const stopped=new Promise(resolve=>child.once("exit",resolve));child.kill();await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,3000))]);}await prisma.auditLog.deleteMany({where:{actorId:{in:users}}});await prisma.user.deleteMany({where:{id:{in:users}}});await prisma.$disconnect();});
async function login(role:"CUSTOMER"|"SUPER_ADMIN"|"HOST_EMPLOYEE"="CUSTOMER"){
 const user=await createTestCustomer({role});users.push(user.id);const session=await createDeviceSession(user.id),context=await browser.newContext({ignoreHTTPSErrors:true});
 const token=await encode({token:{...session,id:user.id,sub:user.id,email:user.email,role},secret,salt:"__Secure-authjs.session-token"});await context.addCookies([{name:"__Secure-authjs.session-token",value:token,url:base,secure:true,httpOnly:true,sameSite:"Lax"}]);return {context,user,session};
}
it.skipIf(!enabled)("web case queue removes revoked employees' linked cases while retaining standalone requests with the same cookie",async()=>{
 const {user:owner,hostProfile}=await createTestHost();users.push(owner.id);
 const customer=await createTestCustomer();users.push(customer.id);
 const vehicle=await createTestVehicle({hostId:hostProfile.id});
 const reservation=await createTestReservation({vehicleId:vehicle.id,customerId:customer.id,pickupAt:new Date("2057-01-01"),returnAt:new Date("2057-01-02"),status:"CONFIRMED"});
 const caseIds:string[]=[];
 try {
  for(const change of ["removed","inactive","expired"]){
   const {context,user}=await login("HOST_EMPLOYEE");
   try {
    const membership=await prisma.hostEmployee.create({data:{userId:user.id,hostId:hostProfile.id}});
    const data={kind:"TICKET",category:"OTHER",openedById:user.id,details:{},dueAt:new Date("2058-01-01"),retainUntil:new Date("2059-01-01")};
    const linked=await prisma.serviceCase.create({data:{...data,title:"Linked synthetic "+crypto.randomUUID(),reservationId:reservation.id,vehicleId:vehicle.id}});
    const standalone=await prisma.serviceCase.create({data:{...data,title:"Standalone synthetic "+crypto.randomUUID()}});caseIds.push(linked.id,standalone.id);
    const queue=async()=>{const response=await context.request.get(base+"/connect?view=cases");expect(response.status()).toBe(200);return response.text();};
    const before=await queue();expect(before).toContain(linked.title);expect(before).toContain(standalone.title);
    if(change==="removed")await prisma.hostEmployee.delete({where:{id:membership.id}});
    else await prisma.hostEmployee.update({where:{id:membership.id},data:change==="inactive"?{isActive:false}:{expiresAt:new Date(Date.now()-1000)}});
    const after=await queue();expect(after).not.toContain(linked.title);expect(after).toContain(standalone.title);
   }finally{await context.close();}
  }
 }finally{
  await prisma.serviceCase.deleteMany({where:{id:{in:caseIds}}});
  await prisma.reservation.delete({where:{id:reservation.id}});await prisma.vehicle.delete({where:{id:vehicle.id}});
  await prisma.hostEmployee.deleteMany({where:{hostId:hostProfile.id}});await prisma.hostProfile.delete({where:{id:hostProfile.id}});
 }
},90000);
it.skipIf(!enabled)("enforces staging configuration, real database sessions, secure responses and protected cron routes in the production build",async()=>{
 const {context,user,session}=await login(),page=await context.newPage();const response=await page.goto(base+"/account/security");
 expect(response?.status()).toBe(200);expect(response?.headers()["strict-transport-security"]).toContain("max-age=31536000");expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-eval");expect(response?.headers()["cache-control"]).toContain("no-store");
 await page.getByRole("heading",{name:"Account security",exact:true}).waitFor();// Streaming may briefly retain the incoming subtree alongside its placeholder. Require a unique settled device label; never select an arbitrary duplicate.
 await expect.poll(()=>page.getByText("Browser (this device)",{exact:true}).count()).toBe(1);await page.getByText("Browser (this device)",{exact:true}).waitFor();await page.screenshot({path:"test-artifacts/staging/account-security.png",fullPage:true});
 await page.getByLabel("One-use security code",{exact:true}).fill("000000");await page.getByRole("button",{name:"Rotate session credential",exact:true}).click();await page.getByRole("status").filter({hasText:"A fresh security code is required."}).waitFor();
 expect((await(await context.request.get(base+"/api/auth/session")).json()).user.id).toBe(user.id);
 expect((await context.request.get(base+"/api/admin/operations")).status()).toBe(403);
 const denied=await context.request.post(base+"/api/account/security",{headers:{origin:"https://untrusted.invalid"},data:{action:"revokeAll"}});expect(denied.status()).toBe(403);expect(denied.headers()["cache-control"]).toContain("no-store");expect(denied.headers()["strict-transport-security"]).toContain("max-age=31536000");expect(denied.headers()["content-security-policy"]).toContain("default-src 'none'");
 expect((await context.request.post(base+"/api/account/security",{data:{action:"revokeAll"}})).status()).toBe(403);
 expect((await context.request.post(base+"/api/reservations/synthetic/confirm-dev-payment",{headers:{origin:base},data:{}})).status()).toBe(403);
 for(const route of ["/api/cron/operations/scan","/api/cron/operations/delete","/api/cron/operations/monitor","/api/cron/financial/recovery","/api/cron/payouts/recovery","/api/cron/community","/api/cron/expire-holds"])expect((await context.request.post(base+route)).status(),route).toBe(401);
 const health=await context.request.get(base+"/api/health/ready");expect(health.status()).toBe(503);expect(await health.json()).toEqual({ready:false});
 await prisma.session.update({where:{id:session.sid},data:{revokedAt:new Date()}});expect((await context.request.get(base+"/api/account/security")).status()).toBe(401);expect((await(await context.request.get(base+"/api/auth/session")).json()).user).toBeUndefined();
 expect(await prisma.user.count({where:{id:user.id,isActive:true}})).toBe(1);await context.close();
},120000);
it.skipIf(!enabled)("keeps live money disabled and requires fresh reauthentication through the real staging admin route",async()=>{
 const {context}=await login("SUPER_ADMIN");const status=await context.request.get(base+"/api/admin/operations");expect(status.status()).toBe(200);const body=await status.json();expect(body.configuration).toMatchObject({environment:"staging",ready:true,liveFinanceEnabled:false});expect(JSON.stringify(body)).not.toContain(secret);
 for(const key of ["live_charges","payouts"]){const result=await context.request.post(base+"/api/admin/operations",{headers:{origin:base},data:{action:"feature",key,enabled:true,code:"000000",reason:"Synthetic unauthorized release attempt"}});expect(result.status()).toBe(409);}
 await context.close();
},60000);
it.skipIf(!enabled)("revokes the database device on Auth.js sign-out so replaying its old encrypted cookie cannot authenticate",async()=>{
 const {context,session}=await login();const original=await context.cookies(),csrf=await(await context.request.get(base+"/api/auth/csrf")).json();
 const response=await context.request.post(base+"/api/auth/signout",{headers:{origin:base,"X-Auth-Return-Redirect":"1"},form:{csrfToken:csrf.csrfToken,callbackUrl:base}});expect(response.ok()).toBe(true);
 expect((await prisma.session.findUniqueOrThrow({where:{id:session.sid}})).revokedAt).not.toBeNull();
 await context.addCookies(original);expect((await context.request.get(base+"/api/account/security")).status()).toBe(401);await context.close();
},60000);

it.skipIf(!enabled)("public production pages hydrate under fresh per-request CSP nonces",async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();const errors:string[]=[];
 page.on("pageerror",e=>errors.push(e.name));page.on("console",m=>{if(m.type()==="error")errors.push(m.text().replace(/nonce-[^' ]+/g,"nonce-[redacted]").replace(/https?:\/\/[^\s]+/g,"[URL]"));});
 try {
  const first=await page.goto(base+"/");await page.getByRole("button",{name:"SUV",exact:true}).click();
  await expect.poll(()=>page.getByRole("button",{name:"SUV",exact:true}).getAttribute("aria-pressed")).toBe("true");
  const second=await page.reload();await page.getByRole("button",{name:"Sedan",exact:true}).click();
  await expect.poll(()=>page.getByRole("button",{name:"Sedan",exact:true}).getAttribute("aria-pressed")).toBe("true");
  const nonce=(header:string|undefined)=>header?.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce(first?.headers()["content-security-policy"])).toBeTruthy();expect(nonce(first?.headers()["content-security-policy"])).not.toBe(nonce(second?.headers()["content-security-policy"]));
  expect(errors).toEqual([]);
 }finally{await context.close();}
},90000);

it.skipIf(!enabled)("native bearer auth crosses the real production proxy without weakening web cookie CSRF",async()=>{
 const user=await createTestCustomer({emailVerified:new Date()});users.push(user.id);
 await prisma.authCode.create({data:{email:user.email,purpose:"MOBILE_SIGN_IN",codeHash:await bcrypt.hash("123456",4),expiresAt:new Date(Date.now()+60000)}});
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 try {
  const suppliedRequestId="00000000-0000-4000-8000-000000000000";
  const signed=await context.request.post(base+"/api/v1/mobile/auth/sign-in",{headers:{"x-request-id":suppliedRequestId},data:{email:user.email,code:"123456",deviceId:crypto.randomUUID(),platform:"ANDROID",appVersion:"1.0.0"}});
  expect(signed.status()).toBe(200);expect(signed.headers()["x-api-version"]).toBe("1");expect(signed.headers()["cache-control"]).toContain("no-store");
  const signedBody=await signed.json();expect(signed.headers()["x-request-id"]).toBe(signedBody.requestId);
  expect(signedBody.requestId).not.toBe(suppliedRequestId);expect(signed.headers()["content-security-policy"]).toContain("default-src 'none'");
  const credentials=signedBody.data;
  expect((await context.request.get(base+"/api/v1/mobile/me")).status()).toBe(401);
  const headers={authorization:"Bearer "+credentials.accessToken};
  expect((await context.request.get(base+"/api/v1/mobile/me",{headers})).status()).toBe(200);
  // Native credentials do not authenticate a cookie-protected web mutation.
  expect((await context.request.post(base+"/api/account/security",{headers,data:{action:"revokeAll"}})).status()).toBe(403);
  const oversized=await context.request.post(base+"/api/v1/mobile/auth/refresh",{data:{refreshToken:"x".repeat(25000)}});
  expect(oversized.status()).toBe(413);expect((await oversized.json()).error.code).toBe("INVALID_REQUEST");expect(oversized.headers()["x-api-version"]).toBe("1");
  expect(oversized.headers()["x-request-id"]).toBe((await oversized.json()).requestId);
  expect((await context.request.post(base+"/api/v1/mobile/auth/logout",{headers,data:{}})).status()).toBe(200);
  expect((await context.request.get(base+"/api/v1/mobile/me",{headers})).status()).toBe(401);
 }finally{await context.close();await prisma.authCode.deleteMany({where:{email:user.email}});}
},60000);
