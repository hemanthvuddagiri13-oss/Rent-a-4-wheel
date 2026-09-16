import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/utils";
import { RESERVATION_STATUS_LABELS } from "@/lib/constants";
import {
  DocumentReviewRow,
  CancelReservationAdminButton,
  RefundForm,
  CheckOutForm,
  CheckInForm,
} from "@/components/admin/reservation-actions";

export const metadata: Metadata = { title: "Reservation Detail", robots: { index: false } };
export const revalidate = 0;

export default async function AdminReservationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      vehicle: true,
      customer: { include: { customer: true } },
      payments: true,
      refunds: true,
      deposit: true,
      documents: true,
      extras: { include: { extra: true } },
      agreement: true,
    },
  });
  if (!reservation) notFound();

  const successfulPayment = reservation.payments.find((p) => p.type === "RENTAL" && p.status === "SUCCEEDED");
  const alreadyRefunded = reservation.refunds.reduce((sum, r) => sum + r.amountCents, 0);
  const refundableCents = Math.max(0, (successfulPayment?.amountCents ?? 0) - alreadyRefunded);

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold text-white">{reservation.confirmationNumber}</h1>
        <Badge>{RESERVATION_STATUS_LABELS[reservation.status]}</Badge>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Customer</h2>
          <p className="mt-2 text-white">{reservation.customer.name}</p>
          <p className="text-sm text-muted">{reservation.customer.email}</p>
          <p className="text-sm text-muted">{reservation.customer.phone}</p>
          <p className="mt-2 text-xs uppercase tracking-wide text-muted">
            Verification: {reservation.customer.customer?.verificationStatus ?? "PENDING_VERIFICATION"}
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Vehicle</h2>
          <p className="mt-2 text-white">
            {reservation.vehicle.year} {reservation.vehicle.make} {reservation.vehicle.model}
          </p>
          <p className="text-sm text-muted">VIN: {reservation.vehicle.vin}</p>
          <p className="text-sm text-muted">
            {reservation.pickupAt.toLocaleString()} &rarr; {reservation.returnAt.toLocaleString()}
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-white/10 bg-card p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Payment</h2>
        <div className="mt-3 space-y-1 text-sm">
          <Row label="Subtotal" value={formatCurrency(reservation.subtotalCents)} />
          <Row label="Extras" value={formatCurrency(reservation.extrasCents)} />
          <Row label="Taxes" value={formatCurrency(reservation.taxCents)} />
          <Row label="Discount" value={`-${formatCurrency(reservation.discountCents)}`} />
          <Separator className="my-2" />
          <Row label="Total" value={formatCurrency(reservation.totalCents)} bold />
          <Row label="Deposit" value={`${formatCurrency(reservation.depositCents)} (${reservation.deposit?.status ?? "n/a"})`} />
          {reservation.refunds.length > 0 && <Row label="Refunded" value={formatCurrency(alreadyRefunded)} />}
        </div>
        {successfulPayment && refundableCents > 0 && (
          <div className="mt-4">
            <RefundForm reservationId={reservation.id} maxCents={refundableCents} />
          </div>
        )}
      </div>

      <div className="mt-6 rounded-xl border border-white/10 bg-card p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Driver Documents</h2>
        <div className="mt-3 space-y-2">
          {reservation.documents.length === 0 && <p className="text-sm text-muted">No documents uploaded yet.</p>}
          {reservation.documents.map((d) => (
            <DocumentReviewRow key={d.id} id={d.id} side={d.side} status={d.status} />
          ))}
        </div>
      </div>

      {reservation.agreement && (
        <div className="mt-6 rounded-xl border border-white/10 bg-card p-5">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Rental Agreement</h2>
          <p className="mt-2 text-sm text-muted">
            Accepted {reservation.agreement.acceptedAt.toLocaleString()} &middot; version {reservation.agreement.documentVersion}
          </p>
          <a href={`/api/reservations/${reservation.id}/agreement`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-gold hover:underline">
            View PDF
          </a>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {reservation.status === "CONFIRMED" && <CheckOutForm reservationId={reservation.id} />}
        {reservation.status === "ACTIVE" && <CheckInForm reservationId={reservation.id} />}
      </div>

      {["PENDING", "CONFIRMED"].includes(reservation.status) && (
        <div className="mt-6">
          <CancelReservationAdminButton reservationId={reservation.id} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-display text-base font-semibold text-white" : "text-silver"}`}>
      <span className={bold ? "" : "text-muted"}>{label}</span>
      <span className={bold ? "text-gold-bright" : ""}>{value}</span>
    </div>
  );
}
