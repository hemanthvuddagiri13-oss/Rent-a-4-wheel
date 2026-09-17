import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/utils";
import { RESERVATION_STATUS_LABELS } from "@/lib/constants";
import { DocumentReviewRow, CancelReservationAdminButton, RefundForm } from "@/components/admin/reservation-actions";
import { Panel } from "@/components/marketplace/workspace";
import { ActionForm } from "@/components/marketplace/action-form";

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
      conditionReports: { include: { photos: true }, orderBy: { createdAt: "asc" } },
      damageReports: true,
      tripEvents: { orderBy: { createdAt: "desc" }, take: 30 },
      trip: true,
      extras: { include: { extra: true } },
      agreementAcceptances: { where: { type: "RENTAL_AGREEMENT" }, orderBy: { signedAt: "desc" }, take: 1 },
    },
  });
  if (!reservation) notFound();

  const successfulPayment = reservation.payments.find((p) => p.type === "RENTAL" && p.status === "SUCCEEDED");
  const alreadyRefunded = reservation.refunds.filter(r => r.status === "SUCCEEDED").reduce((sum, r) => sum + r.amountCents, 0);
  const pendingRefunds = reservation.refunds.filter(r => r.status === "PENDING").reduce((sum, r) => sum + r.amountCents, 0);
  const refundableCents = Math.max(0, (successfulPayment?.amountCents ?? 0) - alreadyRefunded - pendingRefunds);
  const operations = await prisma.financialOperation.findMany({ where: { reservationId: id, state: { in: ["RETRY", "REVIEW", "RUNNING"] } }, select: { id: true, kind: true, state: true, lastError: true } });

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
          {pendingRefunds > 0 && <Row label="Refund pending" value={formatCurrency(pendingRefunds)} />}
          {reservation.refunds.filter(refund => ["FAILED", "CANCELLED"].includes(refund.status)).map(refund => <p key={refund.id} className="text-amber-300">Refund {formatCurrency(refund.amountCents)}: {refund.status}. {refund.lastError}</p>)}
          {operations.map(operation => <p key={operation.id} className="text-amber-300">{operation.kind}: {operation.state}. {operation.lastError} Reference: {operation.id}</p>)}
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
            <DocumentReviewRow key={d.id} id={d.id} type={d.type} status={d.status} />
          ))}
        </div>
      </div>

      {reservation.agreementAcceptances[0] && (
        <div className="mt-6 rounded-xl border border-white/10 bg-card p-5">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Rental Agreement</h2>
          <p className="mt-2 text-sm text-muted">
            Signed {reservation.agreementAcceptances[0].signedAt.toLocaleString()} &middot; version{" "}
            {reservation.agreementAcceptances[0].documentVersion}
          </p>
          <a href={`/api/reservations/${reservation.id}/agreement`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-gold hover:underline">
            View PDF
          </a>
        </div>
      )}

      <div className="mt-6 space-y-6"><Panel title="Pickup and return evidence">{reservation.conditionReports.map(report => <div key={report.id} className="mb-5 border-b border-white/10 pb-4 text-sm text-silver"><p>{report.submittedByRole} · {report.phase} · {report.mileage} miles · {report.fuelLevel}% fuel / charge · {report.acceptedAt ? "Accepted" : "Awaiting acceptance"}</p><p className="my-2">{report.damageNotes}</p><div className="flex flex-wrap gap-4">{report.photos.map(photo => <a key={photo.id} href={`/api/reservations/${id}/photos/${photo.id}`} className="text-gold-bright underline">{photo.category} photo</a>)}</div></div>)}{reservation.damageReports.map(damage => <p key={damage.id} className="mb-4 whitespace-pre-wrap text-silver">{damage.description}</p>)}{["DISPUTED", "UNDER_CLAIM_REVIEW"].includes(reservation.status) && <ActionForm endpoint={`/api/admin/reservations/${id}/return-review`} label="Record return decision" fields={[{ name: "action", label: "Decision", options: ["REVIEW", "COMPLETE_NO_CHARGE"] }, { name: "reason", label: "Evidence and resolution reason", type: "textarea" }]} />}</Panel><Panel title="Trip audit history"><ol className="space-y-3 text-xs text-silver">{reservation.tripEvents.map(event => <li key={event.id}>{event.createdAt.toISOString()} · {event.type}{event.type === "RETURN_REVIEWED" && <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(event.metadata, null, 2)}</pre>}</li>)}</ol></Panel></div>
      {(["AWAITING_PAYMENT", "CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN"] as string[]).includes(
        reservation.status
      ) && (
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
