import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { confirmAfterRentalPaymentSuccess } from "@/lib/stripe-webhook-handlers";
import { attemptDepositAuthorization } from "@/lib/deposit-authorization";
import { financialProjection } from "@/lib/financial-projection";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const r = await prisma.reservation.findUnique({ where: { id }, include: { deposit: true, payments: { where: { type: "RENTAL", status: "SUCCEEDED" } } } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.customerId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (r.financialDisposition !== "OPEN" || !["PAYMENT_FAILED","CONFIRMED","DOCUMENTS_REQUIRED","READY_FOR_CHECK_IN","CHECK_IN_PROGRESS","READY_TO_START"].includes(r.status) ||
    (r.status === "PAYMENT_FAILED" && (!r.expiresAt || r.expiresAt <= new Date()))) return NextResponse.json({ error: "Deposit recovery unavailable" }, { status: 409 });
  const p = r.payments[0];
  if (!stripe || !p?.stripePaymentIntentId) return NextResponse.json({ error: "Payment provider unavailable" }, { status: 503 });
  try {
    const intent = await stripe.paymentIntents.retrieve(p.stripePaymentIntentId);
    if (r.status === "PAYMENT_FAILED") await confirmAfterRentalPaymentSuccess(r, p, intent, true);
    else await attemptDepositAuthorization(r, intent, true);
    const d = await prisma.securityDeposit.findUnique({ where: { reservationId: id } });
    const depositIntent = d?.stripePaymentIntentId ? await stripe.paymentIntents.retrieve(d.stripePaymentIntentId) : null;
    const current = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: { payments: true, refunds: true, deposit: true } });
    const projection = financialProjection(current);
    const requiresAction = current.financialDisposition === "OPEN" && current.deposit?.stripePaymentIntentId === depositIntent?.id && depositIntent?.status === "requires_action";
    return NextResponse.json({ success: projection.depositValid && current.financialDisposition === "OPEN", requiresAction,
      clientSecret: requiresAction ? depositIntent?.client_secret : null });
  } catch {
    return NextResponse.json({ error: "Deposit recovery is pending. Your rental payment will not be charged again." }, { status: 503 });
  }
}
