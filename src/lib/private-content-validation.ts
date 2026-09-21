import sharp from "sharp";
import {PDFDocument,PDFRawStream,PDFName,PDFArray,PDFDict} from "pdf-lib";
import {inflateSync} from "node:zlib";
import {createHash} from "node:crypto";
export type PrivateResource="IDENTITY"|"BUSINESS"|"CONDITION"|"AGREEMENT"|"COLLABORATION";
const maximum=8*1024*1024;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const forbidden=new Set(["JavaScript","JS","OpenAction","AA","Launch","EmbeddedFile","EmbeddedFiles","RichMedia","XFA","AcroForm","Encrypt","ObjStm"]);
/** A bounded passive PDF subset; unsupported constructs stay quarantined.
 * Compressed object dictionaries and cross-reference streams are refused before pdf-lib can inflate them.
 * Signed PDFs are validated without rewriting their signed bytes.
 */
async function validatePdf(bytes:Buffer){
 const text=bytes.toString("latin1").replace(/#([0-9a-f]{2})/gi,(_,h:string)=>String.fromCharCode(parseInt(h,16)));
 if(!/^%PDF-(1\.[0-7]|2\.0)/.test(text)||!text.trimEnd().endsWith("%%EOF")||/\/(ObjStm|XRef|Encrypt)\b/.test(text))throw new Error("PRIVATE_CONTENT_INVALID");
 const doc=await PDFDocument.load(bytes,{ignoreEncryption:false,throwOnInvalidObject:true,updateMetadata:false});
 if(doc.isEncrypted||doc.getPageCount()<1||doc.getPageCount()>100)throw new Error("PRIVATE_CONTENT_INVALID");
 let decoded=0;
 const check=(object:unknown,depth=0):void=>{
  if(depth>32)throw new Error("PRIVATE_CONTENT_INVALID");
  if(object instanceof PDFName&&forbidden.has(object.decodeText()))throw new Error("PRIVATE_CONTENT_INVALID");
  if(object instanceof PDFDict)for(const [key,value]of object.entries()){check(key,depth+1);check(value,depth+1);}
  if(object instanceof PDFArray)for(const value of object.asArray())check(value,depth+1);
 };
 for(const [,object]of doc.context.enumerateIndirectObjects()){
  check(object);
  if(object instanceof PDFRawStream){
   check(object.dict);
   const filter=object.dict.get(PDFName.of("Filter"));let content=Buffer.from(object.getContents());
   if(filter){if(!(filter instanceof PDFName)||filter.decodeText()!=="FlateDecode")throw new Error("PRIVATE_CONTENT_INVALID");content=inflateSync(content,{maxOutputLength:maximum});}
   decoded+=content.length;if(decoded>32*1024*1024)throw new Error("PRIVATE_CONTENT_INVALID");
  }
 }
 return doc.getPageCount();
}
export async function validatePrivateContent(bytes:Buffer,mimeType:string,resource:PrivateResource){
 if(!bytes.length||bytes.length>maximum)throw new Error("PRIVATE_CONTENT_INVALID");
 if(mimeType==="application/pdf"){
  if(!["AGREEMENT","BUSINESS"].includes(resource))throw new Error("PRIVATE_CONTENT_INVALID");
  const pages=await validatePdf(bytes);
  return {bytes,mimeType,sha256:sha(bytes),evidence:{validator:"PASSIVE_PDF_V1",pages}};
 }
 if(resource==="AGREEMENT")throw new Error("PRIVATE_CONTENT_INVALID");
 const signature=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":bytes[0]===255&&bytes[1]===216&&bytes[2]===255?"image/jpeg":bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP"?"image/webp":null;
 if(!signature||signature!==mimeType)throw new Error("PRIVATE_CONTENT_INVALID");
 const image=sharp(bytes,{failOn:"error",limitInputPixels:40_000_000,animated:false}),metadata=await image.metadata();
 if(!metadata.width||!metadata.height||metadata.width>16000||metadata.height>16000||metadata.width*metadata.height>40_000_000||(metadata.pages??1)!==1)throw new Error("PRIVATE_CONTENT_INVALID");
 const clean=mimeType==="image/png"?await image.png().toBuffer():mimeType==="image/webp"?await image.webp({quality:90}).toBuffer():await image.jpeg({quality:90}).toBuffer();
 if(clean.length>maximum)throw new Error("PRIVATE_CONTENT_INVALID");
 return {bytes:clean,mimeType,sha256:sha(clean),evidence:{validator:"RASTER_V1",format:metadata.format!,width:metadata.width,height:metadata.height,metadataStripped:true}};
}
