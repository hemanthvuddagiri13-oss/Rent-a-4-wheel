import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * A condition report can only be accepted by its own author — this is the
 * "both parties accepted the condition report" gate, and self-acceptance
 * (not a counterparty rubber-stamp) is exactly what it's supposed to mean.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; reportId: string }> }
) {
  const { id: reservationId, reportId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const report = await prisma.conditionReport.findUnique({ where: { id: reportId } });
  if (!report || report.reservationId !== reservationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (report.submittedById !== session.user.id) {
    return NextResponse.json({ error: "Only the report's author can accept it." }, { status: 403 });
  }
  if (report.acceptedAt) {
    return NextResponse.json({ success: true, alreadyAccepted: true });
  }

  await prisma.conditionReport.update({ where: { id: reportId }, data: { acceptedAt: new Date() } });
  await prisma.tripEvent.create({
    data: {
      reservationId,
      type: "CONDITION_REPORT_ACCEPTED",
      actorId: session.user.id,
      metadata: { conditionReportId: reportId },
    },
  });

  return NextResponse.json({ success: true });
}
