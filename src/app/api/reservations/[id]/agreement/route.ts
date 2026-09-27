import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";
import { canAccessAdmin } from "@/lib/rbac";
import { generateAndStoreSignedAgreementPdf } from "@/lib/agreements";
import { validateDeviceSession } from "@/lib/device-sessions";

/** Only the immutable signed artifact, under an independently authenticated web
 * session. Neither native bearer credentials nor a browser URL confer access. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, session = await auth();
  if (!session?.user || !session.sessionId || typeof session.credentialVersion !== "number") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const { sessionId, credentialVersion } = session, userId = session.user.id;
  const authorize = async () => {
    const actor = await validateDeviceSession(userId, sessionId, credentialVersion);
    if (!actor) throw new Error("Unavailable");
    const reservation = await prisma.reservation.findUnique({ where: { id }, select: { customerId: true, agreementAcceptances: { where: { type: "RENTAL_AGREEMENT" }, orderBy: { signedAt: "desc" }, take: 1 } } });
    if (!reservation || reservation.customerId !== userId && !canAccessAdmin(actor.role)) throw new Error("Unavailable");
    return reservation.agreementAcceptances[0];
  };
  try {
    let acceptance = await authorize();
    if (acceptance && !acceptance.signedPdfStorageKey && acceptance.subjectSnapshot) {
      await generateAndStoreSignedAgreementPdf(id); acceptance = await authorize();
    }
    if (!acceptance?.signedPdfStorageKey) throw new Error("Unavailable");
    const { buffer, revalidate } = await readPrivateDocument(acceptance.signedPdfStorageKey);
    const current = await authorize();
    if (!current || current.id !== acceptance.id || current.signedPdfStorageKey !== acceptance.signedPdfStorageKey || current.contentHash !== acceptance.contentHash || current.signedByUserId !== acceptance.signedByUserId || buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("Unavailable");
    await prisma.auditLog.create({ data: { actorId: userId, action: "agreement.download", entityType: "AgreementAcceptance", entityId: acceptance.id } });
    await revalidate();
    if (!await validateDeviceSession(userId, sessionId, credentialVersion)) throw new Error("Unavailable");
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="rental-agreement.pdf"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } });
  } catch { return NextResponse.json({ error: "Signed agreement unavailable" }, { status: 404, headers: { "Cache-Control": "private, no-store" } }); }
}
