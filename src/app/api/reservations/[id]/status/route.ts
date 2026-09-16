import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const r = await prisma.reservation.findUnique({ where: { id }, include: { payments: true, deposit: true, refunds: true } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.customerId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const paid = r.payments.filter(p => p.type === "RENTAL" && p.status === "SUCCEEDED").reduce((n,p)=>n+p.amountCents,0);
  const refunded = r.refunds.filter(f=>f.status === "SUCCEEDED").reduce((n,f)=>n+f.amountCents,0);
  const pending = r.refunds.some(f=>f.status === "PENDING");
  const failed = r.refunds.some(f=>f.status === "FAILED" || f.status === "CANCELLED");
  let outcome = "processing";
  if (paid > 0 && refunded >= paid) outcome = "refunded";
  else if (pending || r.financialDisposition === "REFUND_REQUIRED") outcome = failed && !pending ? "refund_failed" : "refund_pending";
  else if (r.financialDisposition === "REVIEW") outcome = "review_required";
  else if (["CANCELLED_BY_CUSTOMER","CANCELLED_BY_HOST"].includes(r.status)) outcome = "cancelled";
  else if (r.status === "EXPIRED") outcome = "expired";
  else if (r.depositCents > 0 && r.deposit?.stripeStatus === "requires_action") outcome = "deposit_action_required";
  else if (r.status === "PAYMENT_FAILED") outcome = "payment_failed";
  else if (paid > refunded && r.financialDisposition === "OPEN" && ["CONFIRMED","DOCUMENTS_REQUIRED","READY_FOR_CHECK_IN","CHECK_IN_PROGRESS","READY_TO_START","ACTIVE"].includes(r.status)) {
    const valid = r.depositCents === 0 || (r.deposit?.status === "SUCCEEDED" && r.deposit.stripeStatus === "requires_capture" && r.deposit.authorizationExpiresAt && r.deposit.authorizationExpiresAt > new Date());
    outcome = valid ? "confirmed" : "payment_failed";
  }
  return NextResponse.json({ status: r.status, outcome, paidCents: paid, refundedCents: refunded,
    rentalPaymentStatus: r.payments.find(p=>p.type==="RENTAL")?.status ?? null, depositStatus: r.deposit?.stripeStatus ?? null },
    { headers: { "Cache-Control": "private, no-store" } });
}
