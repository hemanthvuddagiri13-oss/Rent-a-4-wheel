import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CancelReservationButton } from "@/components/account/cancel-reservation-button";
import { formatCurrency } from "@/lib/utils";
import { RESERVATION_STATUS_LABELS } from "@/lib/constants";
import { canCustomerCancel } from "@/lib/reservation-rules";
import { TripConsole } from "@/components/marketplace/trip-console";
import { PaymentStatus } from "@/components/marketplace/payment-status";
import { ActionForm } from "@/components/marketplace/action-form";

export const metadata: Metadata = { title: "Reservation Details", robots: { index: false } };

export default async function ReservationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return null;

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: {
      vehicle: { include: { images: { take: 1, orderBy: { position: "asc" } } } },
      payments: true,
      extras: { include: { extra: true } },
    },
  });
  if (!reservation || reservation.customerId !== session.user.id) notFound();

  const canCancel = canCustomerCancel(reservation).allowed;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <Link href="/account" className="text-sm text-muted hover:text-gold">
        &larr; Back to My Account
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">{reservation.confirmationNumber}</h1>
          <p className="text-sm text-muted">
            {reservation.vehicle.year} {reservation.vehicle.make} {reservation.vehicle.model}
          </p>
        </div>
        <Badge>{RESERVATION_STATUS_LABELS[reservation.status]}</Badge>
      </div>

      <div className="mt-6 relative aspect-[16/9] w-full overflow-hidden rounded-xl bg-surface">
        <Image src={reservation.vehicle.images[0]?.url || "/images/vehicles/sedan.svg"} alt="" fill className="object-cover" />
      </div>

      <div className="mt-6 rounded-xl border border-white/10 bg-card p-6">
        <Row label="Pickup" value={reservation.pickupAt.toLocaleString("en-US")} />
        <Row label="Return" value={reservation.returnAt.toLocaleString("en-US")} />
        <Row label="Location" value={reservation.pickupLocation} />
        <Separator className="my-3" />
        <Row label="Rental Subtotal" value={formatCurrency(reservation.subtotalCents)} />
        {reservation.extras.length > 0 && (
          <Row label="Extras" value={reservation.extras.map((e) => e.extra.name).join(", ")} />
        )}
        <Row label="Taxes" value={formatCurrency(reservation.taxCents)} />
        <Row label="Discount" value={`-${formatCurrency(reservation.discountCents)}`} />
        <Separator className="my-3" />
        <Row label="Total" value={formatCurrency(reservation.totalCents)} bold />
        <Row label="Security Deposit" value={formatCurrency(reservation.depositCents)} />
      </div>

      <div className="mt-6">
        <h2 className="font-display text-lg font-semibold text-white">Payment History</h2>
        {reservation.payments.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No payments recorded yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {reservation.payments.map((p) => (
              <div key={p.id} className="flex justify-between rounded-lg border border-white/10 bg-card p-3 text-sm">
                <span className="text-silver">
                  {p.type.replace(/_/g, " ")} &middot; {p.createdAt.toLocaleDateString()}
                </span>
                <span className="font-medium text-white">{formatCurrency(p.amountCents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <a href={`/api/reservations/${reservation.id}/agreement`} target="_blank" rel="noreferrer">
            <Download className="h-4 w-4" /> Download Agreement
          </a>
        </Button>
        {canCancel && <CancelReservationButton reservationId={reservation.id} />}
        <Button asChild variant="ghost">
          <Link href="/contact">Contact Support</Link>
        </Button>
      </div>
      <div className="mt-8 space-y-6"><PaymentStatus id={reservation.id} />
        {["CHECKOUT_HOLD", "AWAITING_PAYMENT"].includes(reservation.status) && <Link href={`/book/${reservation.vehicleId}?reservationId=${reservation.id}`} className="block text-gold-bright underline">Resume checkout</Link>}
        <details className="rounded-xl border border-white/10 p-5"><summary className="cursor-pointer text-white">Upload or replace an identity document</summary><div className="mt-5"><ActionForm endpoint="/api/documents/upload" multipart values={{ reservationId: reservation.id }} label="Upload identity document" fields={[{ name: "type", label: "Document", options: ["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE"] }, { name: "file", label: "Private image (maximum 8 MB)", type: "file" }]} /></div></details>
        <TripConsole reservationId={reservation.id} /></div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 text-sm ${bold ? "font-display text-base font-semibold text-white" : "text-silver"}`}>
      <span className={bold ? "" : "text-muted"}>{label}</span>
      <span className={bold ? "text-gold-bright" : ""}>{value}</span>
    </div>
  );
}
