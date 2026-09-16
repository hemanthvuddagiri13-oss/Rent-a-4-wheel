import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readPrivateDocument } from "@/lib/storage";

/**
 * Streams a driver's license (or other private) document only to its
 * owner or an admin/staff reviewer. Never served from /public and never
 * linkable by unauthenticated users.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const document = await prisma.driverDocument.findUnique({ where: { id } });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = document.userId === session.user.id;
  const isReviewer = ["ADMIN", "STAFF"].includes(session.user.role);
  if (!isOwner && !isReviewer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { buffer } = await readPrivateDocument(document.storageKey);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
    },
  });
}
