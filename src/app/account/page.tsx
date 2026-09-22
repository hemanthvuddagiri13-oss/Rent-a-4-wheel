import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { RESERVATION_STATUS_LABELS } from "@/lib/constants";
import { ProfileForm } from "@/components/account/profile-form";

export const metadata: Metadata = { title: "My Account", robots: { index: false } };

// Factual, server-status-derived explanations only — never a promise about
// timing, approval or outcome the backend hasn't already decided.
const ATTENTION_REASONS: Record<string, string> = {
  AWAITING_PAYMENT: "Review payment status and any remaining booking requirements.",
  PAYMENT_FAILED: "Your last payment attempt didn't go through. Review payment status.",
  DOCUMENTS_REQUIRED: "Review the required identity documents and their current status.",
  DISPUTED: "This trip's return is under damage review.",
  UNDER_CLAIM_REVIEW: "A claim on this trip is under review.",
};

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user) return null; // middleware guarantees a session here

  const [user, reservations] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id }, include: { customer: true } }),
    prisma.reservation.findMany({
      where: { customerId: session.user.id },
      include: { vehicle: { include: { images: { take: 1, orderBy: { position: "asc" } } } } },
      orderBy: { pickupAt: "desc" },
    }),
  ]);

  const now = new Date();
  const CANCELLED_STATUSES = ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_HOST", "EXPIRED"];
  // Grouped by current server status first, not only by date: a reservation
  // that needs the customer to act or that's under review surfaces at the
  // top regardless of when it's scheduled, instead of blending into a plain
  // date-sorted list.
  const needsAttention = reservations.filter((r) => r.status in ATTENTION_REASONS);
  const upcoming = reservations.filter((r) => !(r.status in ATTENTION_REASONS) && r.returnAt >= now && !CANCELLED_STATUSES.includes(r.status));
  const past = reservations.filter((r) => !(r.status in ATTENTION_REASONS) && (r.returnAt < now || CANCELLED_STATUSES.includes(r.status)));

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="font-display text-3xl font-bold text-white">My Account</h1>
      <Link href="/account/security" className="inline-block py-3 text-gold-bright underline">Account security and active sessions</Link>
      {user?.isActive && ["FINANCE_AGENT","ADMIN","SUPER_ADMIN"].includes(user.role) && <Link href="/finance/admin" className="inline-block rounded-lg border border-gold/30 px-4 py-3 text-gold-bright">Open financial administration →</Link>}
      <p className="mt-1 text-muted">Welcome back, {user?.name || user?.email}.</p>

      {needsAttention.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-xl font-semibold text-white">Action or review pending</h2>
          <div className="mt-4 space-y-3">
            {needsAttention.map((r) => (
              <ReservationRow key={r.id} r={r} attentionReason={ATTENTION_REASONS[r.status]} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold text-white">Upcoming Rentals</h2>
        {upcoming.length === 0 ? (
          <p className="mt-3 text-sm text-muted">You have no upcoming rentals. Ready to book one?</p>
        ) : (
          <div className="mt-4 space-y-3">
            {upcoming.map((r) => (
              <ReservationRow key={r.id} r={r} />
            ))}
          </div>
        )}
        {upcoming.length === 0 && (
          <Button asChild className="mt-4">
            <Link href="/vehicles">Browse Vehicles</Link>
          </Button>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold text-white">Previous Rentals</h2>
        {past.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No past rentals yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {past.map((r) => (
              <ReservationRow key={r.id} r={r} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold text-white">Contact Information</h2>
        <Card className="mt-4">
          <CardContent className="pt-6">
            <ProfileForm
              defaultValues={{
                name: user?.name ?? "",
                phone: user?.phone ?? "",
                addressLine1: user?.customer?.addressLine1 ?? "",
                city: user?.customer?.city ?? "",
                state: user?.customer?.state ?? "",
                zip: user?.customer?.zip ?? "",
              }}
            />
          </CardContent>
        </Card>
      </section>

      <section className="mt-10 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link href="/contact">Contact Support</Link>
        </Button>
      </section>
    </div>
  );
}

// Semantic status color: text labels (RESERVATION_STATUS_LABELS) always
// carry the meaning too, so color is never the only signal.
const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "destructive"> = {
  CANCELLED_BY_CUSTOMER: "secondary",
  CANCELLED_BY_HOST: "secondary",
  EXPIRED: "secondary",
  COMPLETED: "secondary",
  ACTIVE: "success",
  PAYMENT_FAILED: "destructive",
  DISPUTED: "destructive",
  AWAITING_PAYMENT: "warning",
  DOCUMENTS_REQUIRED: "warning",
  UNDER_CLAIM_REVIEW: "warning",
};

function ReservationRow({
  r,
  attentionReason,
}: {
  r: {
    id: string;
    confirmationNumber: string;
    status: string;
    pickupAt: Date;
    returnAt: Date;
    totalCents: number;
    vehicle: { year: number; make: string; model: string; images: { url: string }[] };
  };
  attentionReason?: string;
}) {
  const statusVariant = STATUS_VARIANTS[r.status] ?? "default";
  return (
    <Link
      href={`/account/reservations/${r.id}`}
      className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3 rounded-xl border border-white/10 bg-card p-4 transition-colors hover:border-gold/30 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:gap-4"
    >
      <div className="relative h-16 w-full overflow-hidden rounded-md bg-surface">
        <Image src={r.vehicle.images[0]?.url || "/images/vehicles/sedan.svg"} alt="" fill className="object-cover" />
      </div>
      <div className="min-w-0">
        <p className="font-medium text-white">
          {r.vehicle.year} {r.vehicle.make} {r.vehicle.model}
        </p>
        <p className="break-words text-sm text-muted">
          {r.pickupAt.toLocaleDateString()} — {r.returnAt.toLocaleDateString()} &middot; {r.confirmationNumber}
        </p>
        {attentionReason && <p className="mt-1 break-words text-sm text-amber-400">{attentionReason}</p>}
      </div>
      <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3 sm:col-span-1 sm:block sm:border-0 sm:pt-0 sm:text-right">
        <Badge variant={statusVariant}>{RESERVATION_STATUS_LABELS[r.status]}</Badge>
        <p className="mt-1 text-sm font-semibold text-gold-bright">{formatCurrency(r.totalCents)}</p>
      </div>
    </Link>
  );
}
