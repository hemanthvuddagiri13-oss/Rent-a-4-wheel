import { uploadBookingDocument } from "./helpers/booking-document";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page } from "playwright";
import path from "node:path";
let server:ViteDevServer,browser:Browser,base:string;
const root=path.resolve(__dirname,"..");
beforeAll(async()=>{
 const stub=path.join(root,'tests/browser-fixture/next-stubs.tsx');
 server=await createServer({configFile:false,root:path.join(root,'tests/browser-fixture'),plugins:[react()],resolve:{alias:[{find:'@',replacement:path.join(root,'src')},...['next/navigation','next/link','next/image','next-auth/react'].map(find=>({find,replacement:stub}))]},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},define:{'process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY':'""'}});
 await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No browser fixture listener');base='http://127.0.0.1:'+address.port;
 browser=await chromium.launch({headless:true});
},60000);
afterAll(async()=>{await browser?.close();await server?.close()});
async function setup(page:Page){
 const counts={holds:0,checkouts:0,payments:0,resumes:0};let complete=false;
 const breakdown={rateType:'DAILY',rateAmountCents:5000,units:3,days:3,subtotalCents:15000,extrasCents:0,discountCents:0,taxCents:0,feesCents:0,totalCents:15000,depositCents:0,extraLineItems:[]};
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());let data:unknown={};
  if(url.pathname==='/api/reservations/hold'){counts.holds++;data={id:'browser-reservation',confirmationNumber:'TEST-BROWSER',expiresAt:new Date(Date.now()+60000).toISOString(),bookingFingerprint:'fixed',breakdown}}
  else if(url.pathname==='/api/documents/upload')data={id:'SYNTHETIC_DOCUMENT_'+Math.random(),malwareScanStatus:'CLEAN'};
  else if(url.pathname.endsWith('/checkout')){counts.checkouts++;complete=true;data={success:true}}
  else if(url.pathname.endsWith('/payment-intent')){counts.payments++;data={devMode:true}}
  else if(url.pathname.endsWith('/status'))data={status:complete?'AWAITING_PAYMENT':'CHECKOUT_HOLD',outcome:'processing',paidCents:0};
  else if(url.pathname.endsWith('/resume')){counts.resumes++;data={reservationId:'browser-reservation',vehicleId:'browser-vehicle',confirmationNumber:'TEST-BROWSER',pickupAt:'2037-01-01T10:00:00Z',returnAt:'2037-01-04T10:00:00Z',selectedExtraIds:[],couponCode:'',checkoutComplete:complete,bookingFingerprint:'fixed',breakdown,status:complete?'AWAITING_PAYMENT':'CHECKOUT_HOLD'}}
  else throw new Error('Unexpected browser request '+url.pathname);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 return counts;
}
async function reachPayment(page:Page, expectedPaymentAction = 'Simulate Successful Payment'){
 await page.goto(base);
 for(let i=0;i<3;i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('heading',{name:'Driver Information'}).waitFor();
 const fields={'First Name':'SYNTHETIC_PRIVATE','Last Name':'Driver','Date of Birth':'1990-01-01','Email':'fixture@example.com','Phone':'5551234567','Address':'SYNTHETIC_PRIVATE_ADDRESS','City':'Dallas','State':'TX','ZIP':'75001','Country':'US','License Number':'SYNTHETIC_PRIVATE_LICENSE','License State/Country':'TX','License Expiration':'2038-01-01'};
 for(const [name,value] of Object.entries(fields))await page.getByLabel(name,{exact:true}).fill(value);
 for(let i=0;i<3;i++)await uploadBookingDocument(page,i,Buffer.from('synthetic image'));
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('heading',{name:'Review Your Booking'}).waitFor();
 await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'Continue to Payment'}).click();
 if (expectedPaymentAction) await page.getByRole('button',{name:expectedPaymentAction}).waitFor();
}
describe('booking browser resumption with real React components and controlled HTTP/provider boundaries',()=>{
 it('announces failed resumption without claiming that a previous payment was not charged',async()=>{
  const page=await browser.newPage();try{
   const counts=await setup(page);
   await page.route('**/api/reservations/*/resume',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Unavailable"}'}));
   await page.goto(base+'/?reservationId=browser-reservation');
   await page.getByRole('alert').waitFor();
   expect(await page.getByRole('alert').innerText()).toContain("couldn't verify the current status");
   expect(await page.getByRole('alert').innerText()).not.toContain('Nothing was charged');
   expect(await page.getByRole('link',{name:'Check my trips'}).getAttribute('href')).toBe('/account');
   expect(counts.payments).toBe(0);
  }finally{await page.close()}
 });
 it('closed historical checkout displays an announced rejection and never creates a payment intent',async()=>{
  const page=await browser.newPage();try{
   const counts=await setup(page);
   await page.route('**/api/reservations/*/checkout',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({historicalCheckout:true,paymentEligible:false,error:'Current booking approval does not permit payment.'})}));
   await reachPayment(page,'');
   await page.getByRole('alert').waitFor();
   expect(await page.getByRole('alert').innerText()).toContain("Payment isn't currently available");
   expect(await page.getByRole('button',{name:'Simulate Successful Payment'}).count()).toBe(0);
   expect(counts.payments).toBe(0);
  }finally{await page.close()}
 },60000);
 it('Review → payment → Back → payment preserves one immutable reservation',async()=>{const page=await browser.newPage();try{const counts=await setup(page);await reachPayment(page);const holds=counts.holds;await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('heading',{name:'Review Your Booking'}).waitFor();await page.getByRole('button',{name:'Continue to Payment'}).click();await page.getByRole('button',{name:'Simulate Successful Payment'}).waitFor();expect(counts.holds).toBe(holds);expect(counts.checkouts).toBe(1);expect(new URL(page.url()).searchParams.get('reservationId')).toBe('browser-reservation');}finally{await page.close()}},60000);
 it('full reload and Stripe return resume the same reservation without storing identity data',async()=>{const page=await browser.newPage();try{const counts=await setup(page);await reachPayment(page);const holds=counts.holds;await page.reload();await page.getByRole('button',{name:'Simulate Successful Payment'}).waitFor();expect(counts.resumes).toBe(1);await page.goto(base+'/?reservationId=browser-reservation&payment_intent=pi_fixture&payment_intent_client_secret=secret_fixture&redirect_status=succeeded');await page.getByRole('button',{name:'Simulate Successful Payment'}).waitFor();expect(counts.resumes).toBe(2);expect(counts.holds).toBe(holds);expect(counts.checkouts).toBe(1);expect(page.url()).not.toContain('secret_fixture');const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain('SYNTHETIC');expect(storage).not.toContain('1990-01-01');}finally{await page.close()}},60000);
});
