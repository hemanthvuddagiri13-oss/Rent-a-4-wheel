import {it,expect} from "vitest";
import sharp from "sharp";
import {PDFDocument,PDFName,PDFDict,PDFString} from "pdf-lib";
import {validatePrivateContent} from "@/lib/private-content-validation";

it("detects signatures independently, rejects malformed data and strips image metadata",async()=>{
 const jpeg=await sharp({create:{width:20,height:20,channels:3,background:"red"}}).withMetadata({exif:{IFD0:{Artist:"Sensitive fixture metadata"}}}).jpeg().toBuffer();
 await expect(validatePrivateContent(jpeg,"image/png","IDENTITY")).rejects.toThrow("PRIVATE_CONTENT_INVALID");
 await expect(validatePrivateContent(Buffer.from([137,80,78,71,13,10,26,10]),"image/png","IDENTITY")).rejects.toThrow();
 const result=await validatePrivateContent(jpeg,"image/jpeg","IDENTITY");
 expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();expect(result.bytes).not.toEqual(jpeg);
 expect(result.evidence).toMatchObject({validator:"RASTER_V1",width:20,height:20,metadataStripped:true});
});
it("refuses excessive dimensions, expanded pixels, and an oversized compressed input",async()=>{
 const wide=await sharp({create:{width:16001,height:1,channels:3,background:"red"}}).png().toBuffer();
 await expect(validatePrivateContent(wide,"image/png","IDENTITY")).rejects.toThrow("PRIVATE_CONTENT_INVALID");
 // A tiny, valid compressed image whose decoded raster exceeds the pixel cap.
 const bomb=await sharp({create:{width:6400,height:6400,channels:3,background:"white"}}).png().toBuffer();
 expect(bomb.length).toBeLessThan(8*1024*1024);
 await expect(validatePrivateContent(bomb,"image/png","IDENTITY")).rejects.toThrow();
 await expect(validatePrivateContent(Buffer.alloc(8*1024*1024+1),"image/png","IDENTITY")).rejects.toThrow("PRIVATE_CONTENT_INVALID");
});
it("permits passive PDFs only for permitted resources without altering signed bytes",async()=>{
 const doc=await PDFDocument.create();doc.addPage([200,200]);const bytes=Buffer.from(await doc.save({useObjectStreams:false}));
 for(const resource of ["IDENTITY","CONDITION","COLLABORATION"] as const)await expect(validatePrivateContent(bytes,"application/pdf",resource)).rejects.toThrow("PRIVATE_CONTENT_INVALID");
 for(const resource of ["BUSINESS","AGREEMENT"] as const)expect((await validatePrivateContent(bytes,"application/pdf",resource)).bytes).toEqual(bytes);
 doc.catalog.set(PDFName.of("OpenAction"),PDFDict.withContext(doc.context));
 doc.catalog.set(PDFName.of("JS"),PDFString.of("untrusted fixture"));
 await expect(validatePrivateContent(Buffer.from(await doc.save({useObjectStreams:false})),"application/pdf","BUSINESS")).rejects.toThrow("PRIVATE_CONTENT_INVALID");
 await expect(validatePrivateContent(Buffer.from(await doc.save()),"application/pdf","BUSINESS")).rejects.toThrow("PRIVATE_CONTENT_INVALID");
});
