import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { evaluateTripStartGate } from "@/lib/trip-gate";
import { getHostContext, hostOwnsReservation } from "@/lib/host-access";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id }, select: { customerId: true } });
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isCustomer = reservation.customerId === session.user.id;
  const isStaff = ["ADMIN", "STAFF"].includes(session.user.role);
  const hostContext = isCustomer || isStaff ? null : await getHostContext(session.user.id);
  const isHost = hostContext ? await hostOwnsReservation(hostContext, id) : false;
  if (!isCustomer && !isStaff && !isHost) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const gate = await evaluateTripStartGate(id);
  return NextResponse.json(gate);
}
