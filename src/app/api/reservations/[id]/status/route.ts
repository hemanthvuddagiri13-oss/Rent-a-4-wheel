import { financialProjection } from "@/lib/financial-projection";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const r = await prisma.reservation.findUnique({ where: { id }, include: { agreementAcceptances: {where:{type:"RENTAL_AGREEMENT"},orderBy:{signedAt:"desc"},take:1,select:{signedPdfStorageKey:true}}, payments: true, deposit: { include: { operation: true } }, refunds: true } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.customerId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ status: r.status, agreementAvailable: Boolean(r.agreementAcceptances[0]?.signedPdfStorageKey), depositRequired: r.depositCents > 0, ...financialProjection(r) },
    { headers: { "Cache-Control": "private, no-store" } });
}
