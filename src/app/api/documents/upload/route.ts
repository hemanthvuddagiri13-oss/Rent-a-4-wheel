import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { storePrivateDocument } from "@/lib/storage";

const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "You must be signed in to upload documents." }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const side = formData.get("side"); // "FRONT" | "BACK"
  const reservationId = formData.get("reservationId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (side !== "FRONT" && side !== "BACK") {
    return NextResponse.json({ error: "Invalid document side." }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "Unsupported file type. Upload a JPG, PNG, or PDF." }, { status: 400 });
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: "File is too large (max 8MB)." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { storageKey } = await storePrivateDocument(buffer, file.type);

  const document = await prisma.driverDocument.create({
    data: {
      userId: session.user.id,
      reservationId: typeof reservationId === "string" ? reservationId : null,
      side,
      storageKey,
      status: "PENDING_VERIFICATION",
    },
  });

  return NextResponse.json({ id: document.id });
}
