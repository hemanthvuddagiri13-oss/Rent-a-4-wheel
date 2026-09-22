import { it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import lighthouse from "lighthouse";
import { chromium } from "playwright";
import { encode } from "next-auth/jwt";
import { createDeviceSession } from "@/lib/device-sessions";
import { createTestCustomer, prisma } from "./helpers/factories";

it.skipIf(process.env.PHASE6_LIGHTHOUSE !== "true")("measures public and authenticated production-build pages without publishing session credentials", async () => {
  const base="https://localhost:3220", secret=randomBytes(48).toString("hex"),cron=randomBytes(48).toString("hex"), output="test-artifacts/phase6/performance";
  await mkdir(output,{recursive:true});
 if(!process.env.CI_TLS_CERT||!process.env.CI_TLS_KEY)throw new Error("Disposable TLS fixture required");
 const database=new URL(process.env.DATABASE_URL!);database.searchParams.set("sslmode","require");database.searchParams.set("sslaccept","strict");database.searchParams.set("sslcert",process.env.CI_TLS_CERT);
 const env:NodeJS.ProcessEnv={...process.env,APP_ENV:"staging",NODE_ENV:"production",STAGING_TEST_PORT:"3220",BROWSER_TEST_PORT:"",DATABASE_URL:database.toString(),DIRECT_DATABASE_URL:database.toString(),SITE_URL:base,AUTH_URL:base,NEXTAUTH_URL:base,NEXT_PUBLIC_SITE_URL:base,PRIMARY_DOMAIN:"localhost",AUTH_SECRET:secret,AUTH_TRUST_HOST:"true",CRON_SECRET:cron,STRIPE_SECRET_KEY:"sk_test_fixture",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"pk_test_fixture",STRIPE_WEBHOOK_SECRET:"whsec_fixture",STRIPE_CONNECT_COUNTRY:"US",RESEND_API_KEY:"re_fixture",EMAIL_FROM:"Staging <staging@renta4wheel.com>",PRIVATE_STORAGE_PROVIDER:"s3",PRIVATE_STORAGE_ENV:"staging",PRIVATE_STORAGE_BUCKET:"isolated-staging",PRIVATE_STORAGE_REGION:"us-east-1",PRIVATE_STORAGE_ENDPOINT:"https://localhost:1",PRIVATE_STORAGE_KMS_KEY_ID:"arn:aws:kms:us-east-1:000000000000:key/synthetic",PRIVATE_STORAGE_ACCESS_KEY_ID:"synthetic",PRIVATE_STORAGE_SECRET_ACCESS_KEY:"synthetic",CLAMAV_HOST:"localhost",CLAMAV_PORT:"1",CLAMAV_TLS:"true",RATE_LIMIT_STORE:"postgres",MONITORING_ALERT_URL:"https://localhost:1",MONITORING_ALERT_SECRET:randomBytes(48).toString("hex"),DEPLOYMENT_DATA_ENV:"staging",PROVIDER_ACCOUNT_ENV:"staging",ALLOW_DEV_PAYMENT_SIMULATION:"false",ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV:"false",LOCAL_BUILD_WORKER_THREADS:"false",NODE_EXTRA_CA_CERTS:process.env.CI_TLS_CERT};
  const app=spawn(process.execPath,["tests/helpers/staging-server.mjs"],{stdio:"inherit",env});
  const browser=await chromium.launch({headless:true,args:["--remote-debugging-port=9222","--ignore-certificate-errors"]});
  const probe=await browser.newContext({ignoreHTTPSErrors:true});
  const results=[];
  const cdp=await browser.newBrowserCDPSession();
  try {
    let ready=false;
    for(let i=0;i<120;i++){if(app.exitCode!==null)throw new Error("Production performance server exited");try{if((await probe.request.get(base+"/api/health/live")).ok()){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
    expect(ready).toBe(true);
    const user=await createTestCustomer({name:"Synthetic performance guest"});
    const token=await encode({token:{...await createDeviceSession(user.id),id:user.id,sub:user.id,email:user.email,role:user.role},secret,salt:"__Secure-authjs.session-token"});
    const cookie=`__Secure-authjs.session-token=${token}`;
    const account=await probe.request.get(base+"/account",{headers:{cookie},maxRedirects:0});expect(account.status()).toBe(200);
    for(const route of ["/","/vehicles","/account","/account/security"]){
      if(route.startsWith("/account")) await cdp.send("Storage.setCookies",{cookies:[{name:"__Secure-authjs.session-token",value:token,url:base,secure:true,httpOnly:true,sameSite:"Lax"}]});
      const result=await lighthouse(base+route,{port:9222,logLevel:"error",output:"json",onlyCategories:["performance","accessibility","best-practices","seo"],disableStorageReset:true,extraHeaders:route.startsWith("/account")?{Cookie:cookie}:{}});
      if(!result)throw new Error("Missing Lighthouse result");
      expect(result.lhr.runtimeError).toBeUndefined();
      expect(new URL(result.lhr.finalDisplayedUrl).pathname).toBe(route);
      const scores=Object.fromEntries(Object.entries(result.lhr.categories).map(([name,category])=>[name,Math.round((category.score??0)*100)]));
      // Do not serialize configSettings, request headers, cookies or page screenshots.
      results.push({route,sha:process.env.BASELINE_APPLICATION_SHA??process.env.GITHUB_SHA,formFactor:result.lhr.configSettings.formFactor,scores,seoFailures:result.lhr.categories.seo.auditRefs.filter(ref=>ref.weight>0&&result.lhr.audits[ref.id]?.score===0).map(ref=>ref.id),audits:Object.values(result.lhr.audits).filter(a=>a.score!==null&&a.score<1).map(a=>({id:a.id,title:a.title,score:a.score,displayValue:a.displayValue}))});
    }
    await writeFile(output+"/scores.json",JSON.stringify(results,null,2));
    await writeFile(output+"/index.html",`<!doctype html><html lang="en"><meta charset="utf-8"><title>Measured Lighthouse results</title><h1>Production-build Lighthouse measurements</h1><pre>${JSON.stringify(results,null,2).replaceAll("&","&amp;").replaceAll("<","&lt;")}</pre></html>`);
    for(const result of results){expect(result.scores.performance,result.route+" performance").toBeGreaterThanOrEqual(90);expect(result.scores.accessibility,result.route+" accessibility").toBeGreaterThanOrEqual(95);expect(result.scores["best-practices"],result.route+" best practices").toBeGreaterThanOrEqual(95);if(result.route.startsWith("/account")){expect(result.seoFailures,"Approved private-page SEO exception: indexing must stay blocked, with no other SEO failure").toEqual(["is-crawlable"]);}else expect(result.scores.seo,result.route+" SEO").toBeGreaterThanOrEqual(90);}
  } finally {await browser?.close();app.kill();await prisma.$disconnect();}
},600000);
