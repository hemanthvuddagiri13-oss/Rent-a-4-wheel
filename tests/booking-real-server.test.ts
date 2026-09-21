import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { encode } from "next-auth/jwt";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prisma, createTestVehicle, createTestCustomer, cleanupReservationsForVehicles } from "./helpers/factories";
import { bookingLocal } from "@/lib/booking-time";
import { createDeviceSession } from "@/lib/device-sessions";
let child:ChildProcess,browser:Browser,context:BrowserContext,page:Page;
const base="http://127.0.0.1:3199",secret="isolated-browser-test-secret-not-a-deployment-secret";
const vehicles:string[]=[],users:string[]=[],extras:string[]=[],coupons:string[]=[];
let priorLegal:Awaited<ReturnType<typeof prisma.legalDocument.findUnique>>;
let priorZone:Awaited<ReturnType<typeof prisma.siteSetting.findUnique>>;
beforeAll(async()=>{
 priorLegal=await prisma.legalDocument.findUnique({where:{type:"RENTAL_AGREEMENT"}});
 priorZone=await prisma.siteSetting.findUnique({where:{key:"bookingTimezone"}});
 await prisma.siteSetting.upsert({where:{key:"bookingTimezone"},create:{key:"bookingTimezone",value:"America/Chicago"},update:{value:"America/Chicago"}});
 await prisma.legalDocument.upsert({where:{type:"RENTAL_AGREEMENT"},update:{needsAttorneyReview:false},create:{type:"RENTAL_AGREEMENT",title:"Synthetic test agreement",content:"Synthetic terms for integration test only",version:"test",needsAttorneyReview:false}});
 child=spawn(process.execPath,["tests/helpers/app-server.mjs"],{stdio:"inherit",env:{...process.env,NODE_ENV:"development",TZ:"Asia/Tokyo",AUTH_SECRET:secret,AUTH_TRUST_HOST:"true",NEXTAUTH_URL:base,AUTH_URL:base,STRIPE_SECRET_KEY:"",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"",STRIPE_WEBHOOK_SECRET:"",ALLOW_DEV_PAYMENT_SIMULATION:"true",ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV:"true"}});
 const deadline=Date.now()+120000;let ready=false;
 while(Date.now()<deadline){try{await fetch(base+"/api/auth/session");ready=true;break}catch{await new Promise(r=>setTimeout(r,500))}}
 if(!ready)throw new Error("Real Next server did not start");
 browser=await chromium.launch({headless:true});context=await browser.newContext({timezoneId:"America/Los_Angeles"});page=await context.newPage();
},150000);
afterAll(async()=>{
 await browser?.close();child?.kill();
 await cleanupReservationsForVehicles(vehicles);await prisma.vehicle.deleteMany({where:{id:{in:vehicles}}});await prisma.extra.deleteMany({where:{id:{in:extras}}});await prisma.coupon.deleteMany({where:{id:{in:coupons}}});await prisma.user.deleteMany({where:{id:{in:users}}});
 if(priorLegal)await prisma.legalDocument.update({where:{type:"RENTAL_AGREEMENT"},data:{needsAttorneyReview:priorLegal.needsAttorneyReview}});else await prisma.legalDocument.deleteMany({where:{type:"RENTAL_AGREEMENT"}});
 if(priorZone)await prisma.siteSetting.update({where:{key:"bookingTimezone"},data:{value:priorZone.value!}});else await prisma.siteSetting.deleteMany({where:{key:"bookingTimezone"}});
 await prisma.$disconnect();
});
describe("real Next application, browser, API and PostgreSQL checkout",()=>{
 it("preserves Chicago instants, selections, revision and fingerprint across Back, reload and Stripe return with Tokyo server / Los Angeles browser",async()=>{
  const v=await createTestVehicle({securityDepositCents:0}),u=await createTestCustomer();vehicles.push(v.id);users.push(u.id);
  const extra=await prisma.extra.create({data:{name:"Browser child seat",chargeType:"ONE_TIME",amountCents:1200}});extras.push(extra.id);
  const inactive=await prisma.extra.create({data:{name:"Unavailable fixture",chargeType:"ONE_TIME",amountCents:900,isActive:false}});extras.push(inactive.id);
  const coupon=await prisma.coupon.create({data:{code:"BROWSER"+Date.now(),discountType:"FIXED",amountCents:1000,startsAt:new Date(0),expiresAt:new Date("2040-01-01"),isActive:true,applicableVehicleIds:[v.id]}});coupons.push(coupon.id);
  const device=await createDeviceSession(u.id);
  const token=await encode({token:{id:u.id,sub:u.id,email:u.email,role:"CUSTOMER",sid:device.sid,rotation:device.rotation},secret,salt:"authjs.session-token"});
  await context.addCookies([{name:"authjs.session-token",value:token,url:base,httpOnly:true,sameSite:"Lax"}]);
  // Real HTTP requests prove rejection before the UI creates its first hold.
  const request={vehicleId:v.id,draftId:randomUUID(),revision:1,pickupAt:"2030-03-09T10:00:00",returnAt:"2030-03-12T10:00:00",extraIds:[] as string[]};
  for(const invalid of [{extraIds:[inactive.id]},{couponCode:"DOES_NOT_EXIST"},{pickupAt:"2030-03-10T02:30:00"},{pickupAt:"2030-11-03T01:30:00",returnAt:"2030-11-05T10:00:00"}]){
   const response=await context.request.post(base+"/api/reservations/hold",{data:{...request,...invalid}});expect(response.status(),await response.text()).toBe(400);
  }
  expect(await prisma.reservation.count({where:{vehicleId:v.id}})).toBe(0);
  await page.goto(base+"/book/"+v.id+"?pickupDate=2030-03-09&pickupTime=10:00&returnDate=2030-03-12&returnTime=10:00");
  await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByText("Browser child seat",{exact:true}).click();await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("heading",{name:"Driver Information"}).waitFor();
  const fields={"First Name":"Synthetic","Last Name":"Driver","Date of Birth":"1990-01-01","Email":u.email,"Phone":"5551234567","Address":"100 Test Street","City":"Dallas","State":"TX","ZIP":"75001","Country":"US","License Number":"SYNTHETIC_ONLY","License State/Country":"TX","License Expiration":"2035-01-01"};
  for(const [name,value]of Object.entries(fields))await page.getByLabel(name,{exact:true}).fill(value);
  const buffer=await sharp({create:{width:20,height:20,channels:3,background:"white"}}).png().toBuffer();
  for(let i=0;i<3;i++){const uploaded=page.waitForResponse(r=>r.url().endsWith("/api/documents/upload"));await page.locator("input[type=file]").nth(i).setInputFiles({name:"synthetic.png",mimeType:"image/png",buffer});expect((await uploaded).status()).toBe(200)}
  await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByRole("heading",{name:"Review Your Booking"}).waitFor();
  await page.getByLabel("Promo Code").fill(coupon.code);const applied=page.waitForResponse(r=>r.url().endsWith("/api/reservations/hold"));await page.getByRole("button",{name:"Apply",exact:true}).click();expect((await applied).status()).toBe(200);
  await page.getByRole("checkbox").check();await page.getByRole("button",{name:"Continue to Payment"}).click();await page.getByRole("button",{name:"Simulate Successful Payment"}).waitFor();
  const id=new URL(page.url()).searchParams.get("reservationId")!;
  const saved=await prisma.reservation.findUniqueOrThrow({where:{id},include:{extras:true}}),draft=await prisma.bookingDraft.findFirstOrThrow({where:{reservationId:id}});
  expect(saved.pickupAt.toISOString()).toBe("2030-03-09T16:00:00.000Z");expect(saved.returnAt.toISOString()).toBe("2030-03-12T15:00:00.000Z");expect(saved.bookingTimezone).toBe("America/Chicago");
  expect(saved.extras.map(e=>[e.extraId,e.quantity,e.amountCents])).toEqual([[extra.id,1,1200]]);expect(saved.units).toBe(3);expect(saved.couponId).toBe(coupon.id);expect(saved.discountCents).toBe(1000);expect(saved.taxCents).toBe(1254);expect(saved.totalCents).toBe(16454);expect(saved.bookingFingerprint).toBe(draft.fingerprint);expect(saved.checkoutFingerprint).toBeTruthy();
  const historyCount=await prisma.reservation.count({where:{vehicleId:v.id}});expect(historyCount).toBe(2);
  expect(await prisma.reservation.count({where:{vehicleId:v.id,status:"EXPIRED"}})).toBe(1);
  for(const action of ["back","reload","stripe"]){
   if(action==="reload")await page.reload();
   if(action==="stripe")await page.goto(base+"/book/"+v.id+"?reservationId="+id+"&payment_intent=pi_fixture&payment_intent_client_secret=synthetic_secret&redirect_status=succeeded");
   await page.getByRole("button",{name:"Simulate Successful Payment"}).waitFor();await page.getByRole("button",{name:"Back",exact:true}).click();
   await page.getByRole("heading",{name:"Review Your Booking"}).waitFor();
   expect(await page.getByText("2030-03-09 at 10:00",{exact:true}).count()).toBe(1);expect(await page.getByText("2030-03-12 at 10:00",{exact:true}).count()).toBe(1);
   expect(await page.getByText("Browser child seat × 1",{exact:true}).count()).toBe(1);expect(await page.getByText("All booking times: America/Chicago",{exact:true}).count()).toBe(1);
   expect(await page.getByLabel("Promo Code").inputValue()).toBe(coupon.code);expect(await page.getByText("$164.54",{exact:true}).count()).toBeGreaterThan(0);
   const resumed=await prisma.reservation.findUniqueOrThrow({where:{id}});expect([resumed.pickupAt,resumed.returnAt,resumed.bookingFingerprint,resumed.checkoutFingerprint]).toEqual([saved.pickupAt,saved.returnAt,saved.bookingFingerprint,saved.checkoutFingerprint]);
   expect((await prisma.bookingDraft.findUniqueOrThrow({where:{id:draft.id}})).revision).toBe(draft.revision);expect(await prisma.reservation.count({where:{vehicleId:v.id}})).toBe(historyCount);expect(await prisma.reservation.count({where:{vehicleId:v.id,status:{not:"EXPIRED"}}})).toBe(1);
   expect(bookingLocal(resumed.pickupAt,resumed.bookingTimezone)).toBe("2030-03-09T10:00");
   await page.getByRole("button",{name:"Continue to Payment"}).click();
  }
 },180000);
 it("refreshes revoked roles and disabled accounts on real authenticated HTTP requests",async()=>{
   const isolated=await browser.newContext();
   const u=await createTestCustomer({role:"SUPER_ADMIN"});users.push(u.id);
   const device=await createDeviceSession(u.id);
   const token=await encode({token:{id:u.id,sub:u.id,email:u.email,role:"SUPER_ADMIN",sid:device.sid,rotation:device.rotation},secret,salt:"authjs.session-token"});
   await isolated.addCookies([{name:"authjs.session-token",value:token,url:base,httpOnly:true,sameSite:"Lax"}]);
   expect((await (await isolated.request.get(base+"/api/auth/session")).json()).user.role).toBe("SUPER_ADMIN");
   await prisma.user.update({where:{id:u.id},data:{role:"CUSTOMER"}});
   expect((await (await isolated.request.get(base+"/api/auth/session")).json()).user).toMatchObject({id:u.id,role:"CUSTOMER"});
   await prisma.user.update({where:{id:u.id},data:{isActive:false}});
   expect((await (await isolated.request.get(base+"/api/auth/session")).json()).user).toBeUndefined();
   expect((await isolated.request.get(base+"/api/reservations/missing/status")).status()).toBe(401);
   await isolated.close();
 });

});
