import { PDFDocument,StandardFonts,rgb } from "pdf-lib";

const label=(key:string)=>key.replace(/Cents$/," (minor units)").replace(/([a-z])([A-Z])/g,"$1 $2").replaceAll("_"," ");
export async function renderFinancePdf(snapshot:Record<string,unknown>){
 const doc=await PDFDocument.create(),regular=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
 doc.setCreationDate(new Date(0));doc.setModificationDate(new Date(0));doc.setTitle(String(snapshot.kind).replaceAll("_"," "));doc.setAuthor("Rent A 4Wheel");
 let page=doc.addPage([612,792]),y=674;
 const header=()=>{page.drawRectangle({x:0,y:710,width:612,height:82,color:rgb(.06,.06,.06)});page.drawText("RENT A 4WHEEL",{x:40,y:751,size:18,font:bold,color:rgb(.85,.7,.35)});page.drawText(String(snapshot.kind).replaceAll("_"," "),{x:40,y:727,size:11,font:regular,color:rgb(1,1,1)});};header();
 const text=(value:string,heading=false)=>{const clean=value.replace(/[^\x20-\x7e]/g," ");let remaining=clean;do{let end=Math.min(remaining.length,heading?68:94);if(end<remaining.length){const space=remaining.lastIndexOf(" ",end);if(space>20)end=space;}const line=remaining.slice(0,end);remaining=remaining.slice(end).trimStart();if(y<65){page=doc.addPage([612,792]);header();y=674;}page.drawText(line,{x:40,y,size:heading?12:10,font:heading?bold:regular,color:heading?rgb(.42,.3,.1):rgb(.15,.15,.15)});y-=heading?24:16;}while(remaining);};
 text(`Version ${snapshot.version} | Currency ${String(snapshot.currency).toUpperCase()} | Time zone ${snapshot.timezone}`);y-=8;
 const walk=(value:unknown,key="",depth=0)=>{
  if(value===undefined||value===null)return;
  if(Array.isArray(value)){text(label(key),true);if(!value.length)text("No entries in this snapshot.");for(let i=0;i<value.length;i++){text(`Entry ${i+1}`,true);walk(value[i],"",depth+1);}return;}
  if(typeof value==="object"){if(key)text(label(key),true);for(const [k,v]of Object.entries(value))walk(v,k,depth+1);return;}
  const shown=typeof value==="number"&&key.endsWith("Cents")?`${(value/100).toFixed(2)} ${String(snapshot.currency).toUpperCase()} (${value} minor units)`:String(value);
  text(`${label(key).replace(" (minor units)","")}: ${shown}`);
 };
 for(const [key,value]of Object.entries(snapshot))if(!["kind","version","currency","timezone","templateVersion","snapshotHash"].includes(key))walk(value,key);
 const pages=doc.getPages();for(let i=0;i<pages.length;i++){pages[i].drawLine({start:{x:40,y:44},end:{x:572,y:44},thickness:1,color:rgb(.8,.8,.8)});pages[i].drawText(`Private financial record | ${snapshot.templateVersion} | Page ${i+1} of ${pages.length}`,{x:40,y:29,size:8,font:regular,color:rgb(.35,.35,.35)});}
 return Buffer.from(await doc.save());
}
