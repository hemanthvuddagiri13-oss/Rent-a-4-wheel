import {readFile,writeFile,mkdir} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
const root="test-artifacts/phase6",after=JSON.parse(await readFile(root+"/candidate/manifest.json","utf8")),before=JSON.parse(await readFile(root+"/before/manifest.json","utf8"));
const escape=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
const stable=new Set(["contact","faq","how-it-works","long-term-rentals","sign-in","sign-up"]);
await mkdir(root+"/diffs",{recursive:true});
const comparisons=[];
for(const capture of after.captures){
 const old=before.captures.find(c=>c.name===capture.name&&c.role===capture.role&&c.width===capture.width);
 if(!old){comparisons.push({route:capture.route,role:capture.role,width:capture.width,scenario:capture.scenario??"initial",after:"candidate/"+capture.image,status:"New route; no approved baseline"});continue;}
 let comparison={route:capture.route,role:capture.role,width:capture.width,scenario:capture.scenario??"initial",before:"before/"+old.image,after:"candidate/"+capture.image,status:"dynamic fixture; visual comparison only"};
 if(stable.has(capture.name)){
  const a=await sharp(root+"/"+comparison.before).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const b=await sharp(root+"/"+comparison.after).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(a.info.width!==b.info.width||a.info.height!==b.info.height)comparison={...comparison,status:"layout dimensions changed; inspect before/after",beforeSize:[a.info.width,a.info.height],afterSize:[b.info.width,b.info.height]};
  else{
   const diff=Buffer.alloc(b.data.length);let changed=0;
   for(let i=0;i<b.data.length;i+=4){const different=Math.max(...[0,1,2].map(c=>Math.abs(a.data[i+c]-b.data[i+c])))>20;if(different)changed++;diff[i]=different?255:30;diff[i+1]=different?90:30;diff[i+2]=different?120:30;diff[i+3]=255;}
   const name=path.basename(capture.image);await sharp(diff,{raw:{width:b.info.width,height:b.info.height,channels:4}}).png().toFile(root+"/diffs/"+name);
   comparison={...comparison,status:changed?"changed; visual review required":"identical",changedPixels:changed,changedPercent:100*changed/(b.info.width*b.info.height),diff:"diffs/"+name};
  }
 }
 comparisons.push(comparison);
}
for(const capture of after.zoomCaptures??[])comparisons.push({route:capture.route,role:capture.role,width:capture.width,scenario:capture.scenario,after:"candidate/"+capture.image,status:"200% CSS zoom; no approved zoom baseline"});
for(const capture of after.keyboardCaptures??[])comparisons.push({route:capture.route,role:capture.role,width:capture.width,scenario:capture.scenario,after:"candidate/"+capture.image,status:"Recorded keyboard focus state; manual visual inspection required"});
await writeFile(root+"/comparisons.json",JSON.stringify({baselineSha:before.applicationSha,applicationSha:after.applicationSha,comparisons},null,2));
await writeFile(root+"/index.html",`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Phase 6 sanitized before and after</title><style>body{background:#101214;color:#eee;font:16px system-ui;margin:24px}a{color:#e9cb87}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}img{width:100%;height:auto}article{border-top:1px solid #777;margin-top:32px}h2{overflow-wrap:anywhere}select{font:inherit;padding:10px}</style><h1>Sanitized Phase 6 before / after gallery</h1><p>Synthetic fixtures only. Automated measurements and visual inspection are separate evidence.</p><p><a href="candidate/index.html">All candidate routes</a> · <a href="candidate/manifest.json">Route, role, viewport, scenario and audit manifest</a> · <a href="comparisons.json">Screenshot differences</a> · <a href="performance/index.html">Lighthouse measurements</a></p><label>Viewport <select id="width"><option value="">All widths</option>${after.sizes.map(([w])=>`<option>${w}</option>`).join("")}</select></label>${comparisons.map(c=>`<article data-width="${c.width}"><h2>${escape(c.role)} · ${escape(c.route)} · ${c.width}px · ${escape(c.scenario)}</h2><p>${escape(c.status)}${c.diff?` · <a href="${c.diff}">Pixel difference</a>`:""}</p><div class="pair"><div><h3>Approved baseline</h3>${c.before?`<a href="${c.before}"><img loading="lazy" alt="Before" src="${c.before}"></a>`:"<p>No stable baseline for this scenario.</p>"}</div><div><h3>Candidate</h3><a href="${c.after}"><img loading="lazy" alt="After" src="${c.after}"></a></div></div></article>`).join("")}<script>document.querySelector('#width').onchange=e=>document.querySelectorAll('article').forEach(a=>a.hidden=!!e.target.value&&a.dataset.width!==e.target.value)</script></html>`);
console.info(JSON.stringify({comparisons:comparisons.length,pixelComparisons:comparisons.filter(c=>c.diff).length}));
