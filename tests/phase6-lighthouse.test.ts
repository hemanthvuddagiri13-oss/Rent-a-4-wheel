import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import lighthouse from "lighthouse";
import { chromium } from "playwright";
import { encode } from "next-auth/jwt";
import { createDeviceSession } from "@/lib/device-sessions";
import { createTestCustomer, prisma } from "./helpers/factories";

it.skipIf(process.env.PHASE6_LIGHTHOUSE !== "true")("measures public and authenticated production-build pages without publishing session credentials", async () => {
  const base="http://127.0.0.1:3220", secret="isolated-performance-fixture-only", output="test-artifacts/phase6/performance";
  await mkdir(output,{recursive:true});
  const app=spawn(process.execPath,["node_modules/next/dist/bin/next","start","-p","3220"],{stdio:"inherit",env:{...process.env,NODE_ENV:"production",BROWSER_TEST_PORT:"",AUTH_SECRET:secret,AUTH_TRUST_HOST:"true",AUTH_URL:base,NEXTAUTH_URL:base,STRIPE_SECRET_KEY:"",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"",FINANCE_SANDBOX_ENABLED:"false"}});
  let browser;
  const results=[];
  try {
    let ready=false;
    for(let i=0;i<120;i++){if(app.exitCode!==null)throw new Error("Production performance server exited");try{if((await fetch(base+"/api/health/live")).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
    expect(ready).toBe(true);
    browser=await chromium.launch({headless:true,args:["--remote-debugging-port=9222"]});
    const user=await createTestCustomer({name:"Synthetic performance guest"});
    const token=await encode({token:{...await createDeviceSession(user.id),id:user.id,sub:user.id,email:user.email,role:user.role},secret,salt:"authjs.session-token"});
    const cookie=`authjs.session-token=${token}`;
    const account=await fetch(base+"/account",{headers:{cookie},redirect:"manual"});expect(account.status).toBe(200);
    for(const route of ["/","/vehicles","/account","/account/security"]){
      const result=await lighthouse(base+route,{port:9222,logLevel:"error",output:"json",onlyCategories:["performance","accessibility","best-practices","seo"],disableStorageReset:true,extraHeaders:route.startsWith("/account")?{Cookie:cookie}:{}});
      if(!result)throw new Error("Missing Lighthouse result");
      expect(result.lhr.runtimeError).toBeUndefined();
      expect(new URL(result.lhr.finalDisplayedUrl).pathname).toBe(route);
      const scores=Object.fromEntries(Object.entries(result.lhr.categories).map(([name,category])=>[name,Math.round((category.score??0)*100)]));
      // Do not serialize configSettings, request headers, cookies or page screenshots.
      results.push({route,sha:process.env.GITHUB_SHA,formFactor:result.lhr.configSettings.formFactor,scores,audits:Object.values(result.lhr.audits).filter(a=>a.score!==null&&a.score<1).map(a=>({id:a.id,title:a.title,score:a.score,displayValue:a.displayValue}))});
    }
    await writeFile(output+"/scores.json",JSON.stringify(results,null,2));
    await writeFile(output+"/index.html",`<!doctype html><html lang="en"><meta charset="utf-8"><title>Measured Lighthouse results</title><h1>Production-build Lighthouse measurements</h1><pre>${JSON.stringify(results,null,2).replaceAll("&","&amp;").replaceAll("<","&lt;")}</pre></html>`);
    for(const result of results){expect(result.scores.performance,result.route+" performance").toBeGreaterThanOrEqual(90);expect(result.scores.accessibility,result.route+" accessibility").toBeGreaterThanOrEqual(95);expect(result.scores["best-practices"],result.route+" best practices").toBeGreaterThanOrEqual(95);expect(result.scores.seo,result.route+" SEO").toBeGreaterThanOrEqual(90);}
  } finally {await browser?.close();app.kill();await prisma.$disconnect();}
},600000);
