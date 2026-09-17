import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { evidencePdf } from "@/lib/marketplace-pdf";
import { financialProjection } from "@/lib/financial-projection";
import { formatCurrency } from "@/lib/utils";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const r = await prisma.reservation.findFirst({ where: { id, customerId: session.user.id }, include: { payments: true, refunds: true, deposit: { include: { operation: true } }, vehicle: true } });
  if (!r) return new Response("Not found", { status: 404 });
  const f = financialProjection(r);
  if (!f.paidCents) return new Response("No successful payment receipt is available.", { status: 409 });
  const bytes = await evidencePdf("Payment receipt", [`Reservation ${r.confirmationNumber}`, `${r.vehicle.year} ${r.vehicle.make} ${r.vehicle.model}`, `Rental ${r.pickupAt.toISOString()} to ${r.returnAt.toISOString()}`, `Subtotal ${formatCurrency(r.subtotalCents)}`, `Extras ${formatCurrency(r.extrasCents)}`, `Fees ${formatCurrency(r.feesCents)}`, `Tax ${formatCurrency(r.taxCents)}`, `Discount ${formatCurrency(r.discountCents)}`, `Total ${formatCurrency(r.totalCents)}`, `Collected ${formatCurrency(f.paidCents)}`, `Refunded ${formatCurrency(f.refundedCents)}`, `Pending refunds ${formatCurrency(f.pendingRefundCents)}`, `Deposit authorization (not rental payment): ${formatCurrency(r.depositCents)}`, `Status as of ${new Date().toISOString()}`]);
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "receipt.download", entityType: "Reservation", entityId: id } });
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="rental-receipt.pdf"', "Cache-Control": "private, no-store" } });
}
