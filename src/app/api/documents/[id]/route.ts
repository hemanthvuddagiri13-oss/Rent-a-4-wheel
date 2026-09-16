import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";
import { logDocumentAccess } from "@/lib/documents";
import { getRequestIp } from "@/lib/auth-code";
import { getHostContext, hostOwnsVehicle } from "@/lib/host-access";

/**
 * Streams a driver's license (or other private) document only to its
 * owner, an admin/staff reviewer, or the host of a vehicle the document's
 * reservation is attached to. Never served from /public and never
 * linkable by unauthenticated users. Every successful read is written to
 * DocumentAccessLog — no exceptions.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const document = await prisma.driverDocument.findUnique({
    where: { id },
    include: { reservation: { select: { vehicleId: true } } },
  });
  if (!document || document.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = document.userId === session.user.id;
  const isReviewer = ["ADMIN", "STAFF"].includes(session.user.role);

  let isHostReviewer = false;
  let purpose = "owner_view";
  if (!isOwner && !isReviewer && document.reservation?.vehicleId) {
    const hostContext = await getHostContext(session.user.id);
    if (hostContext && (await hostOwnsVehicle(hostContext, document.reservation.vehicleId))) {
      isHostReviewer = true;
      purpose = "host_pickup_verification";
    }
  } else if (isReviewer) {
    purpose = "staff_review";
  }

  if (!isOwner && !isReviewer && !isHostReviewer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await logDocumentAccess({
    documentId: document.id,
    accessedById: session.user.id,
    purpose,
    ipAddress: getRequestIp(req.headers),
  });

  const { buffer } = await readPrivateDocument(document.storageKey);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": document.mimeType || "application/octet-stream",
      "Cache-Control": "private, no-store",
    },
  });
}
