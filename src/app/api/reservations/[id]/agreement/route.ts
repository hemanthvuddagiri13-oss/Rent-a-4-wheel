import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";

/**
 * Serves the immutable, signed rental-agreement PDF generated at signing
 * time (see src/lib/agreements.ts). If signing hasn't happened yet (or the
 * background PDF generation hasn't completed), returns 404 rather than
 * fabricating a preview — the only PDF this route will ever serve is the
 * one that was actually signed.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      agreementAcceptances: { where: { type: "RENTAL_AGREEMENT" }, orderBy: { signedAt: "desc" }, take: 1 },
    },
  });
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = reservation.customerId === session.user.id;
  const isReviewer = ["ADMIN", "STAFF"].includes(session.user.role);
  if (!isOwner && !isReviewer) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const acceptance = reservation.agreementAcceptances[0];
  if (!acceptance?.signedPdfStorageKey) {
    return NextResponse.json({ error: "The rental agreement has not been signed yet." }, { status: 404 });
  }

  const { buffer } = await readPrivateDocument(acceptance.signedPdfStorageKey);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${reservation.confirmationNumber}-rental-agreement.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
