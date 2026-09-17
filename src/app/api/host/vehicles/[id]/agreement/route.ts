import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { marketplaceVehicle, marketplaceHost, MarketplaceError, marketplaceLimit } from "@/lib/marketplace";
import { recordAgreementAcceptance, AgreementNotReviewedError } from "@/lib/agreements";
import { evidencePdf } from "@/lib/marketplace-pdf";
import { storePrivateDocument, readPrivateDocument } from "@/lib/storage";
import { z } from "zod";
import { canAccessAdmin } from "@/lib/rbac";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await marketplaceLimit(session.user.id);
    const data = z.object({ signerName: z.string().trim().min(2).max(150), version: z.string(), accept: z.literal("yes") }).parse(await req.json());
    const acceptance = await prisma.$transaction(async tx => {
      const { role, vehicle } = await marketplaceVehicle(tx, session.user.id, id, true);
      if (role !== "OWNER") throw new MarketplaceError("Only the host owner can sign.", 403);
      await tx.$queryRaw`SELECT "id" FROM "LegalDocument" WHERE "type"='HOST_AGREEMENT' FOR UPDATE`;
      const legal = await tx.legalDocument.findUnique({ where: { type: "HOST_AGREEMENT" } });
      if (legal?.version !== data.version) throw new MarketplaceError("Agreement changed. Reload and review the current version.", 409);
      const prior = await tx.agreementAcceptance.findFirst({ where: { vehicleId: id, signedByUserId: session.user.id, type: "HOST_AGREEMENT", documentVersion: data.version, subjectSnapshot: { path: ["vehicle", "listingRevision"], equals: vehicle.listingRevision } }, orderBy: { signedAt: "desc" } });
      return prior ?? recordAgreementAcceptance(tx, { type: "HOST_AGREEMENT", vehicleId: id, signedByUserId: session.user.id, signerName: data.signerName, ipAddress: null, userAgent: req.headers.get("user-agent") });
    });
    if (!acceptance.signedPdfStorageKey) {
      const pdf = await evidencePdf("Host Vehicle Listing and Management Agreement", [`Version: ${acceptance.documentVersion}`, `SHA-256: ${acceptance.contentHash}`, `Signed by: ${acceptance.signerName}`, `Signed at: ${acceptance.signedAt.toISOString()}`, JSON.stringify(acceptance.subjectSnapshot, null, 2), acceptance.contentSnapshot]);
      const { storageKey } = await storePrivateDocument(pdf, "application/pdf");
      await prisma.agreementAcceptance.updateMany({ where: { id: acceptance.id, signedPdfStorageKey: null }, data: { signedPdfStorageKey: storageKey } });
    }
    return Response.json({ id: acceptance.id });
  } catch (error) {
    return Response.json({ error: error instanceof MarketplaceError || error instanceof AgreementNotReviewedError ? error.message : "Unable to sign. Check your name, consent and agreement version." }, { status: error instanceof MarketplaceError ? error.status : 409 });
  }
}
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!canAccessAdmin(session.user.role)) {
    try {
      const { host } = await marketplaceHost(prisma, session.user.id);
      if (!await prisma.vehicle.findFirst({ where: { id, hostId: host.id } })) return new Response("Forbidden", { status: 403 });
    } catch { return new Response("Forbidden", { status: 403 }); }
  }
  const acceptance = await prisma.agreementAcceptance.findFirst({ where: { id: new URL(req.url).searchParams.get("acceptanceId") ?? "", vehicleId: id, type: "HOST_AGREEMENT" } });
  if (!acceptance?.signedPdfStorageKey) return new Response("Signed PDF unavailable. Retry signing to recover PDF generation.", { status: 404 });
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "agreement.download", entityType: "AgreementAcceptance", entityId: acceptance.id } });
  const { buffer } = await readPrivateDocument(acceptance.signedPdfStorageKey);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="host-agreement.pdf"', "Cache-Control": "private, no-store" } });
}
