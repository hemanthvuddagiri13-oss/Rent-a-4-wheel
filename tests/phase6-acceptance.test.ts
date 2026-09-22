import AxeBuilder from "@axe-core/playwright";
import {it,expect} from "vitest";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdir,writeFile,readdir} from "node:fs/promises";
import {chromium,type Browser,type BrowserContext} from "playwright";
import {encode} from "next-auth/jwt";
import {createDeviceSession} from "@/lib/device-sessions";
import {prisma,createTestCustomer,createTestHost,createTestVehicle,createTestReservation} from "./helpers/factories";

const enabled=process.env.PHASE6_ACCEPTANCE==="true";
const sizes=[[375,812],[390,844],[430,932],[768,1024],[1024,768],[1440,1000]];
const base="http://127.0.0.1:3214",secret="isolated-phase6-baseline-only-session",output=process.env.PHASE6_CANDIDATE==="true"?"test-artifacts/phase6/candidate":"test-artifacts/phase6/baseline";
async function pages(directory="src/app"):Promise<string[]>{const entries=await readdir(directory,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?pages(directory+"/"+e.name):e.name==="page.tsx"?[directory+"/"+e.name]:[]))).flat();}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));

it.skipIf(!enabled)("audits real application routes, roles and six viewports for overflow, accessibility and browser errors",async()=>{
 const dbName=(await prisma.$queryRaw<Array<{name:string}>>`SELECT current_database() name`)[0].name;
 if(dbName!=="phase6_baseline_test")throw new Error("Use the dedicated disposable phase6_baseline_test database");
 await mkdir(output,{recursive:true});
 const customer=await createTestCustomer({name:"Avery — staging guest"}),host=await createTestHost();
 await prisma.user.update({where:{id:host.user.id},data:{name:"Morgan — staging host"}});
 await prisma.hostProfile.update({where:{id:host.hostProfile.id},data:{legalName:"Independent staging host",businessName:"Morgan's test fleet"}});
 const admin=await createTestCustomer({name:"Alex — staging administrator",role:"SUPER_ADMIN"});
 const otherRoles=await Promise.all((["STAFF","ADMIN","FINANCE_AGENT","SUPPORT_AGENT","CLAIMS_AGENT","HOST_EMPLOYEE"] as const).map(role=>createTestCustomer({name:"Staging "+role.toLowerCase().replaceAll("_"," "),role})));
 const employee=otherRoles.find(u=>u.role==="HOST_EMPLOYEE")!;
 await prisma.hostEmployee.create({data:{hostId:host.hostProfile.id,userId:employee.id,role:"STAFF"}});
 const vehicle=await createTestVehicle({hostId:host.hostProfile.id,make:"Toyota",model:"Corolla",location:"Dallas, TX",description:"Synthetic staging listing. This vehicle is not offered for rental.",images:{create:{url:"/images/vehicles/sedan.svg",alt:"Illustrated staging sedan",isPrimary:true}}});
 const reservation=await createTestReservation({customerId:customer.id,vehicleId:vehicle.id,pickupAt:new Date(Date.now()+86400000),returnAt:new Date(Date.now()+4*86400000),status:"CONFIRMED"});
 const conversation=await prisma.conversation.create({data:{reservationId:reservation.id,vehicleId:vehicle.id,customerId:customer.id,retainUntil:new Date("2099-01-01"),messages:{create:{senderId:customer.id,body:"Synthetic staging message: where should we meet for pickup?"}}}});
 const serviceCase=await prisma.serviceCase.create({data:{kind:"TICKET",reservationId:reservation.id,vehicleId:vehicle.id,openedById:customer.id,category:"BOOKING",title:"Synthetic pickup question",details:{description:"Staging support conversation; no private attachments."},dueAt:new Date(Date.now()+86400000),retainUntil:new Date("2099-01-01")}});
 const earning=await prisma.hostEarning.create({data:{reservationId:reservation.id,hostId:host.hostProfile.id,grossCents:15000,commissionCents:1500,hostDiscountCents:0,netCents:13500}});
 const payout=await prisma.$transaction(async tx=>{const batch=await tx.payoutBatch.create({data:{hostId:host.hostProfile.id,accountId:"acct_synthetic_baseline",amountCents:13500,currency:"usd",reason:"Synthetic view only. Live payouts are disabled."}});await tx.payoutItem.create({data:{batchId:batch.id,earningId:earning.id,reservationId:reservation.id,amountCents:13500}});return batch;});
 await prisma.legalDocument.upsert({where:{type:"TERMS_AND_CONDITIONS"},create:{type:"TERMS_AND_CONDITIONS",title:"Terms — unapproved staging content",content:"Staging placeholder. Professional approval is required before public launch.",version:"baseline-unapproved",needsAttorneyReview:true},update:{}});
 const users={visitor:null,customer,host:host.user,admin,...Object.fromEntries(otherRoles.map(u=>[u.role,u]))};
 let child:ChildProcess|undefined,browser:Browser|undefined;
 const contexts:Record<string,BrowserContext>={};
 const captures:Array<Record<string,unknown>>=[];
 try{
  child=spawn(process.execPath,["tests/helpers/app-server.mjs"],{stdio:"inherit",env:{...process.env,BROWSER_TEST_PORT:"3214",NODE_ENV:"development",AUTH_SECRET:secret,AUTH_TRUST_HOST:"true",AUTH_URL:base,NEXTAUTH_URL:base,STRIPE_SECRET_KEY:"",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"",STRIPE_WEBHOOK_SECRET:"",FINANCE_SANDBOX_ENABLED:"false"}});
  let ready=false;for(let i=0;i<240;i++){if(child.exitCode!==null)throw new Error("Baseline app exited");try{const r=await fetch(base+"/api/auth/session");if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}if(!ready)throw new Error("Baseline app did not start");
  browser=await chromium.launch({headless:true});
  for(const [role,user] of Object.entries(users)){
   const context=await browser.newContext({reducedMotion:"reduce"});contexts[role]=context;
   if(user){const token=await encode({token:{...await createDeviceSession(user.id),id:user.id,sub:user.id,email:user.email,role:user.role},secret,salt:"authjs.session-token"});await context.addCookies([{name:"authjs.session-token",value:token,url:base,httpOnly:true,sameSite:"Lax"}]);}
  }
  const files=await pages(),specs=files.map(file=>{
   let route=file.replace(/^src\/app/,"").replace(/\/page\.tsx$/,"")||"/";
   const role=route.startsWith("/admin")||route.startsWith("/finance/admin")?"admin":route.startsWith("/host")||route.startsWith("/finance")?"host":route.startsWith("/account")||route.startsWith("/book")||route.startsWith("/connect")?"customer":"visitor";
   route=route.replace("[slug]",vehicle.slug).replace("[vehicleId]",vehicle.id).replace("[type]","terms-and-conditions");
   if(route.includes("[id]"))route=route.replace("[id]",route.includes("/conversations/")?conversation.id:route.includes("/cases/")?serviceCase.id:route.includes("/payouts/")?payout.id:route.includes("/vehicles/")?vehicle.id:reservation.id);
   return {file,route,role,name:file.replace(/^src\/app\//,"").replace(/\/page\.tsx$/,"").replace("page.tsx","home").replace(/[^a-z0-9]+/gi,"-")};
  });
  for(const view of ["notifications","reviews","support","cases"])specs.push({file:"src/app/connect/page.tsx",route:"/connect?view="+view,role:"customer",name:"connect-"+view});
  for(const role of Object.keys(users).filter(r=>r===r.toUpperCase()))specs.push({file:"role-navigation",route:role==="HOST_EMPLOYEE"?"/host":role==="FINANCE_AGENT"?"/finance/admin":role==="SUPPORT_AGENT"||role==="CLAIMS_AGENT"?"/connect":"/admin",role,name:"role-"+role.toLowerCase()});
  for(const spec of specs){
   const page=await contexts[spec.role].newPage();const consoleErrors:string[]=[];page.on("pageerror",error=>consoleErrors.push(error.name));page.on("console",message=>{if(message.type()==="error")consoleErrors.push("browser-console-error");});const response=await page.goto(base+spec.route,{waitUntil:"networkidle",timeout:90000});await page.evaluate(()=>document.fonts.ready);
   // Do not put private image/document contents or payment credentials in artifacts.
   const sensitive=page.locator('img[src*="/api/documents"],img[src*="/api/host/files"],img[src*="/photos/"],img[src*="/api/community/files"],iframe,canvas,video,input[type="password"],input[autocomplete="cc-number"],[data-sensitive]');
   for(const [width,height] of sizes){
    await page.setViewportSize({width,height});await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(300);
    const metrics=await page.evaluate(()=>{
     const visible=(e:Element)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
     const controls=[...document.querySelectorAll("button,a,input:not([type=hidden]),select,textarea")].filter(visible);
     return {title:document.title,h1:[...document.querySelectorAll("h1")].map(e=>e.textContent),overflow:document.documentElement.scrollWidth>innerWidth,overflowElements:[...document.querySelectorAll("body *")].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1;}).slice(0,12).map(e=>({tag:e.tagName,classes:e.getAttribute("class"),left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})),smallTargets:controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<44||r.height<44;}).length,unlabelledFields:[...document.querySelectorAll<HTMLInputElement>("input:not([type=hidden]),select,textarea")].filter(visible).filter(e=>!e.labels?.length&&!e.getAttribute("aria-label")&&!e.getAttribute("aria-labelledby")).length,mainLandmarks:document.querySelectorAll("main").length};
    });
    const axe=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze();
    const accessibility=axe.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,failureSummary:n.failureSummary}))}));
    const image=spec.name+"-"+width+".png";await page.screenshot({path:output+"/"+image,fullPage:true,animations:"disabled",mask:[sensitive]});captures.push({...spec,width,height,status:response?.status(),image,scenario:"initial",consoleErrors:[...consoleErrors],accessibility,...metrics});
   }
   await page.close();
  }
  await writeFile(output+"/manifest.json",JSON.stringify({applicationSha:process.env.BASELINE_APPLICATION_SHA??"82bfea4648d86386a1b4be51c76935512bacd0f1",fixture:"isolated synthetic PostgreSQL data; no provider calls or private document media",sizes,captures},null,2));
  const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Phase 6 UI observations</title><style>body{font:16px system-ui;background:#101214;color:#eee;margin:24px}a{color:#d8bd7c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}img{width:100%;height:auto;border:1px solid #555}article{min-width:0}h2{overflow-wrap:anywhere}</style><h1>Real application UI observations</h1><p>Synthetic staging data. Screenshots are observations, not acceptance.</p><a href="manifest.json">Route and viewport metrics</a><div class="grid">'+captures.map(c=>'<article><h2>'+escape(String(c.role)+" · "+String(c.route)+" · "+c.width+"×"+c.height)+'</h2><p>HTTP '+c.status+' · overflow '+c.overflow+' · small targets '+c.smallTargets+' · unlabelled fields '+c.unlabelledFields+'</p><a href="'+c.image+'"><img loading="lazy" alt="'+escape(String(c.name))+'" src="'+c.image+'"></a></article>').join("")+"</div></html>";
  await writeFile(output+"/index.html",html);
  expect(captures).toHaveLength(specs.length*sizes.length);
  expect(captures.filter(c=>c.overflow).map(c=>`${c.name}:${c.width}`),"Document overflow").toEqual([]);
  expect(captures.filter(c=>(c.accessibility as unknown[]).length).map(c=>({route:c.name,width:c.width,violations:c.accessibility})),"Automated accessibility violations").toEqual([]);
  expect(captures.filter(c=>(c.consoleErrors as unknown[]).length).map(c=>c.name),"Browser errors").toEqual([]);console.info(JSON.stringify({baselineScreens:specs.length,captures:captures.length,overflow:captures.filter(c=>c.overflow).length,serverErrors:captures.filter(c=>Number(c.status)>=500).length}));
 }finally{await browser?.close();if(child&&child.exitCode===null){const stopped=new Promise(r=>child!.once("exit",r));child.kill();await Promise.race([stopped,new Promise(r=>setTimeout(r,3000))]);}await prisma.$disconnect();}
},1500000);
