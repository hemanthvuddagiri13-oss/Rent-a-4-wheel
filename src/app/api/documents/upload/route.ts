import { safeLog } from "@/lib/safe-log";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { storeIdentityDocument, InvalidDocumentError } from "@/lib/documents";
import type { DocumentType } from "@prisma/client";

const VALID_TYPES: DocumentType[] = ["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "You must be signed in to upload documents." }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const type = formData.get("type");
  const reservationId = formData.get("reservationId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as DocumentType)) {
    return NextResponse.json({ error: "Invalid document type." }, { status: 400 });
  }

  // A document can only ever be associated with a reservation the
  // requesting user actually owns — never trust a client-supplied
  // reservationId without verifying ownership first.
  let ownedReservationId: string | null = null;
  if (typeof reservationId === "string" && reservationId) {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { customerId: true },
    });
    if (!reservation || reservation.customerId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    ownedReservationId = reservationId;
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const document = await storeIdentityDocument({
      userId: session.user.id,
      reservationId: ownedReservationId,
      type: type as DocumentType,
      rawBuffer: buffer,
      declaredMimeType: file.type,
    });
    return NextResponse.json({ id: document.id });
  } catch (err) {
    if (err instanceof InvalidDocumentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    safeLog("DOCUMENT_UPLOAD_FAILED", err);
    return NextResponse.json({ error: "Unable to process this file." }, { status: 500 });
  }
}
