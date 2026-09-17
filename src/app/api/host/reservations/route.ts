import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getHostContext } from "@/lib/host-access";

/**
 * Lists reservations for vehicles belonging to the authenticated user's
 * host account only. Enforced via a `vehicle.hostId` filter, never a
 * client-supplied hostId — a host or host employee can never list another
 * host's bookings by any input to this endpoint.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hostContext = await getHostContext(session.user.id);
  if (!hostContext) return NextResponse.json({ error: "No host account associated with this user." }, { status: 403 });

  const reservations = await prisma.reservation.findMany({
    where: { vehicle: { hostId: hostContext.hostId } },
    select: {
      id: true,
      confirmationNumber: true,
      status: true,
      pickupAt: true,
      returnAt: true,
      vehicle: { select: { id: true, year: true, make: true, model: true } },
    },
    orderBy: { pickupAt: "desc" },
  });

  return NextResponse.json({ reservations });
}
