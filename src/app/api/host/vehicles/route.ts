import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getHostContext } from "@/lib/host-access";

/**
 * Lists vehicles belonging to the authenticated user's host account. Scoped
 * strictly to `hostId` — there is no query parameter or admin-style
 * override that can widen this to another host's fleet.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hostContext = await getHostContext(session.user.id);
  if (!hostContext) return NextResponse.json({ error: "No host account associated with this user." }, { status: 403 });

  const vehicles = await prisma.vehicle.findMany({
    where: { hostId: hostContext.hostId },
    select: { id: true, slug: true, year: true, make: true, model: true, status: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ vehicles });
}
