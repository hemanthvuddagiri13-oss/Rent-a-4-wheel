import {createHash} from "node:crypto";
import {prisma} from "@/lib/prisma";
import {generateRentalAgreementPdf} from "@/lib/agreement-pdf";
import {evidencePdf} from "@/lib/marketplace-pdf";
import {storePrivateDocument} from "@/lib/storage";

/** Freeze rendered bytes before any external write. Every retry uses exactly
 * the same storage identity and bytes, including after a lost attachment write.
 */
export async function generateSignedAgreementArtifact(acceptanceId:string){
 const artifact=await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT financial_guard_xact(${"agreement-artifact:"+acceptanceId})`;
  const acceptance=await tx.agreementAcceptance.findUniqueOrThrow({where:{id:acceptanceId},include:{reservation:{include:{vehicle:true}}}});
  if(acceptance.signedPdfStorageKey)return null;
  const existing=await tx.agreementArtifact.findUnique({where:{acceptanceId}});if(existing)return existing;
  const subject=acceptance.subjectSnapshot as {reservation?:unknown;vehicle?:unknown}|null;
  if(!subject?.vehicle||acceptance.type==="RENTAL_AGREEMENT"&&!subject.reservation)throw new Error("AGREEMENT_EVIDENCE_REVIEW_REQUIRED");
  const pdf=acceptance.type==="RENTAL_AGREEMENT"&&acceptance.reservation?Buffer.from(await generateRentalAgreementPdf({reservation:acceptance.reservation,vehicle:acceptance.reservation.vehicle,acceptance})):acceptance.type==="HOST_AGREEMENT"?await evidencePdf("Host Vehicle Listing and Management Agreement",[`Version: ${acceptance.documentVersion}`,`SHA-256: ${acceptance.contentHash}`,`Signed by: ${acceptance.signerName}`,`Signed at: ${acceptance.signedAt.toISOString()}`,JSON.stringify(acceptance.subjectSnapshot,null,2),acceptance.contentSnapshot]):null;
  if(!pdf)throw new Error("AGREEMENT_EVIDENCE_REVIEW_REQUIRED");
  return tx.agreementArtifact.create({data:{acceptanceId,storageId:"agreement-"+acceptanceId,pdf,sha256:createHash("sha256").update(pdf).digest("hex")}});
 },{timeout:20000});
 if(!artifact)return;
 const bytes=Buffer.from(artifact.pdf);if(createHash("sha256").update(bytes).digest("hex")!==artifact.sha256)throw new Error("AGREEMENT_ARTIFACT_INTEGRITY");
 const {storageKey}=await storePrivateDocument(bytes,"application/pdf",artifact.storageId);
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT financial_guard_xact(${"agreement-artifact:"+acceptanceId})`;
  const acceptance=await tx.agreementAcceptance.findUniqueOrThrow({where:{id:acceptanceId}});
  if(acceptance.signedPdfStorageKey&&acceptance.signedPdfStorageKey!==storageKey)throw new Error("AGREEMENT_ARTIFACT_CONFLICT");
  await tx.agreementAcceptance.updateMany({where:{id:acceptanceId,signedPdfStorageKey:null},data:{signedPdfStorageKey:storageKey}});
 });
}
