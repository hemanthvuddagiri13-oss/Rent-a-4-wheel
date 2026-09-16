import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { RESERVATION_STATUS_LABELS } from "@/lib/constants";
import type { ReservationStatus } from "@prisma/client";

export const metadata: Metadata = { title: "Reservations", robots: { index: false } };
export const revalidate = 0;

const TABS: (ReservationStatus | "ALL")[] = [
  "ALL",
  "CHECKOUT_HOLD",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "DOCUMENTS_REQUIRED",
  "READY_FOR_CHECK_IN",
  "ACTIVE",
  "COMPLETED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_HOST",
  "DISPUTED",
];

const statusVariant: Record<string, "success" | "warning" | "secondary" | "destructive" | "default"> = {
  CHECKOUT_HOLD: "warning",
  AWAITING_PAYMENT: "warning",
  CONFIRMED: "default",
  DOCUMENTS_REQUIRED: "warning",
  READY_FOR_CHECK_IN: "default",
  CHECK_IN_PROGRESS: "default",
  READY_TO_START: "default",
  ACTIVE: "success",
  RETURN_IN_PROGRESS: "default",
  COMPLETED: "secondary",
  CANCELLED_BY_CUSTOMER: "destructive",
  CANCELLED_BY_HOST: "destructive",
  PAYMENT_FAILED: "destructive",
  EXPIRED: "secondary",
  DISPUTED: "destructive",
  UNDER_CLAIM_REVIEW: "destructive",
};

export default async function AdminReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filter = status && TABS.includes(status as ReservationStatus) ? status : "ALL";

  const reservations = await prisma.reservation.findMany({
    where: filter === "ALL" ? {} : { status: filter as ReservationStatus },
    include: { vehicle: true, customer: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <h1 className="font-display text-3xl font-bold text-white">Reservations</h1>

      <div className="mt-5 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={tab === "ALL" ? "/admin/reservations" : `/admin/reservations?status=${tab}`}
            className={`rounded-full border px-4 py-1.5 text-sm ${
              filter === tab ? "border-gold bg-gold/10 text-gold-bright" : "border-white/15 text-muted hover:text-white"
            }`}
          >
            {tab === "ALL" ? "All" : RESERVATION_STATUS_LABELS[tab]}
          </Link>
        ))}
      </div>

      <div className="mt-6 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="bg-surface/60 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Confirmation</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Vehicle</th>
              <th className="px-4 py-3">Dates</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {reservations.map((r) => (
              <tr key={r.id} className="border-t border-white/5 hover:bg-white/5">
                <td className="px-4 py-3">
                  <Link href={`/admin/reservations/${r.id}`} className="font-medium text-gold hover:underline">
                    {r.confirmationNumber}
                  </Link>
                </td>
                <td className="px-4 py-3 text-silver">{r.customer.name || r.customer.email}</td>
                <td className="px-4 py-3 text-silver">
                  {r.vehicle.year} {r.vehicle.make} {r.vehicle.model}
                </td>
                <td className="px-4 py-3 text-muted">
                  {r.pickupAt.toLocaleDateString()} - {r.returnAt.toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-gold-bright">{formatCurrency(r.totalCents)}</td>
                <td className="px-4 py-3">
                  <Badge variant={statusVariant[r.status]}>{RESERVATION_STATUS_LABELS[r.status]}</Badge>
                </td>
              </tr>
            ))}
            {reservations.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted">
                  No reservations found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
