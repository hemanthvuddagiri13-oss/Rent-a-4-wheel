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
  const upcoming = reservations.filter((r) => r.returnAt >= now && !CANCELLED_STATUSES.includes(r.status));
  const past = reservations.filter((r) => r.returnAt < now || CANCELLED_STATUSES.includes(r.status));

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="font-display text-3xl font-bold text-white">My Account</h1>
      <p className="mt-1 text-muted">Welcome back, {user?.name || user?.email}.</p>

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

function ReservationRow({
  r,
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
}) {
  const statusVariant =
    r.status === "CANCELLED" ? "destructive" : r.status === "COMPLETED" ? "secondary" : r.status === "ACTIVE" ? "success" : "default";
  return (
    <Link
      href={`/account/reservations/${r.id}`}
      className="flex items-center gap-4 rounded-xl border border-white/10 bg-card p-4 transition-colors hover:border-gold/30"
    >
      <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md bg-surface">
        <Image src={r.vehicle.images[0]?.url || "/images/vehicles/sedan.svg"} alt="" fill className="object-cover" />
      </div>
      <div className="flex-1">
        <p className="font-medium text-white">
          {r.vehicle.year} {r.vehicle.make} {r.vehicle.model}
        </p>
        <p className="text-xs text-muted">
          {r.pickupAt.toLocaleDateString()} — {r.returnAt.toLocaleDateString()} &middot; {r.confirmationNumber}
        </p>
      </div>
      <div className="text-right">
        <Badge variant={statusVariant}>{RESERVATION_STATUS_LABELS[r.status]}</Badge>
        <p className="mt-1 text-sm font-semibold text-gold-bright">{formatCurrency(r.totalCents)}</p>
      </div>
    </Link>
  );
}
