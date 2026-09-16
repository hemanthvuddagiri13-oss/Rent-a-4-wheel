import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Reservation creation is now a two-step flow — see
// POST /api/reservations/hold (places the 15-minute checkout hold) and
// POST /api/reservations/[id]/checkout (attaches driver info/documents/
// agreement and transitions the hold into AWAITING_PAYMENT).
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservations = await prisma.reservation.findMany({
    where: { customerId: session.user.id, status: { not: "CHECKOUT_HOLD" } },
    include: { vehicle: { include: { images: { take: 1, orderBy: { position: "asc" } } } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ reservations });
}
