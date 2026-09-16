import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getHostContext, hostOwnsReservation } from "@/lib/host-access";

const schema = z.object({
  licenseMatchesUpload: z.boolean(),
  physicalLicenseUnexpired: z.boolean(),
  selfieMatchesCustomer: z.boolean(),
  notes: z.string().optional(),
});

/**
 * Records the host's in-person verification that the customer's physical
 * license matches their uploaded documents and selfie. Only the vehicle's
 * host (owner or an employee scoped to that host) may submit this — a
 * customer can never self-certify their own identity handoff, and a host
 * can never submit this for a vehicle they don't operate.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: reservationId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hostContext = await getHostContext(session.user.id);
  if (!hostContext || !(await hostOwnsReservation(hostContext, reservationId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const allTrue =
    parsed.data.licenseMatchesUpload && parsed.data.physicalLicenseUnexpired && parsed.data.selfieMatchesCustomer;

  const handoff = await prisma.identityHandoffVerification.upsert({
    where: { reservationId },
    create: {
      reservationId,
      verifiedByHostId: session.user.id,
      licenseMatchesUpload: parsed.data.licenseMatchesUpload,
      physicalLicenseUnexpired: parsed.data.physicalLicenseUnexpired,
      selfieMatchesCustomer: parsed.data.selfieMatchesCustomer,
      notes: parsed.data.notes,
      verifiedAt: allTrue ? new Date() : null,
    },
    update: {
      verifiedByHostId: session.user.id,
      licenseMatchesUpload: parsed.data.licenseMatchesUpload,
      physicalLicenseUnexpired: parsed.data.physicalLicenseUnexpired,
      selfieMatchesCustomer: parsed.data.selfieMatchesCustomer,
      notes: parsed.data.notes,
      verifiedAt: allTrue ? new Date() : null,
    },
  });

  await prisma.tripEvent.create({
    data: {
      reservationId,
      type: "IDENTITY_HANDOFF_RECORDED",
      actorId: session.user.id,
      metadata: { verified: allTrue },
    },
  });

  return NextResponse.json({ id: handoff.id, verified: allTrue });
}
