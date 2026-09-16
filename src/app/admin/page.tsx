import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/utils";
import { RevenueChart } from "@/components/admin/revenue-chart";
import {
  Car,
  CheckCircle2,
  DollarSign,
  AlertTriangle,
  Clock,
  FileWarning,
  UserCheck,
  CalendarClock,
} from "lucide-react";

export const metadata: Metadata = { title: "Admin Dashboard", robots: { index: false } };
export const revalidate = 0;

async function getStats() {
  const now = new Date();
  const [
    totalVehicles,
    availableVehicles,
    activeRentals,
    upcomingReservations,
    revenueAgg,
    pendingPayments,
    pendingVerification,
    attentionVehicles,
  ] = await Promise.all([
    prisma.vehicle.count(),
    prisma.vehicle.count({ where: { status: "ACTIVE" } }),
    prisma.reservation.count({ where: { status: "ACTIVE" } }),
    prisma.reservation.count({ where: { status: { in: ["PENDING", "CONFIRMED"] }, pickupAt: { gte: now } } }),
    prisma.payment.aggregate({ where: { status: "SUCCEEDED" }, _sum: { amountCents: true } }),
    prisma.payment.count({ where: { status: "REQUIRES_PAYMENT" } }),
    prisma.customer.count({ where: { verificationStatus: "PENDING_VERIFICATION" } }),
    prisma.vehicle.count({
      where: {
        OR: [
          { registrationExpiresAt: { lt: new Date(now.getTime() + 30 * 86400000) } },
          { insuranceExpiresAt: { lt: new Date(now.getTime() + 30 * 86400000) } },
          { status: "MAINTENANCE" },
        ],
      },
    }),
  ]);

  return {
    totalVehicles,
    availableVehicles,
    activeRentals,
    upcomingReservations,
    revenueCents: revenueAgg._sum.amountCents ?? 0,
    pendingPayments,
    pendingVerification,
    attentionVehicles,
  };
}

async function getMonthlyRevenue() {
  const payments = await prisma.payment.findMany({
    where: { status: "SUCCEEDED", createdAt: { gte: new Date(new Date().setMonth(new Date().getMonth() - 5)) } },
    select: { amountCents: true, createdAt: true },
  });
  const byMonth = new Map<string, number>();
  for (const p of payments) {
    const key = p.createdAt.toLocaleDateString("en-US", { month: "short" });
    byMonth.set(key, (byMonth.get(key) ?? 0) + p.amountCents);
  }
  return Array.from(byMonth.entries()).map(([month, amountCents]) => ({ month, revenue: amountCents / 100 }));
}

async function getBookingsByStatus() {
  const statuses = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
  const counts = await Promise.all(statuses.map((s) => prisma.reservation.count({ where: { status: s } })));
  return statuses.map((status, i) => ({ status, count: counts[i] }));
}

export default async function AdminDashboardPage() {
  const [stats, revenue, bookings] = await Promise.all([getStats(), getMonthlyRevenue(), getBookingsByStatus()]);

  const cards = [
    { label: "Total Vehicles", value: stats.totalVehicles, icon: Car },
    { label: "Available Vehicles", value: stats.availableVehicles, icon: CheckCircle2 },
    { label: "Active Rentals", value: stats.activeRentals, icon: CalendarClock },
    { label: "Upcoming Reservations", value: stats.upcomingReservations, icon: Clock },
    { label: "Revenue", value: formatCurrency(stats.revenueCents), icon: DollarSign },
    { label: "Pending Payments", value: stats.pendingPayments, icon: AlertTriangle },
    { label: "Pending Driver Verification", value: stats.pendingVerification, icon: UserCheck },
    { label: "Vehicles Needing Attention", value: stats.attentionVehicles, icon: FileWarning },
  ];

  return (
    <div>
      <h1 className="font-display text-3xl font-bold text-white">Dashboard</h1>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-white/10 bg-card p-5">
            <div className="flex items-center justify-between">
              <c.icon className="h-5 w-5 text-gold" />
            </div>
            <p className="mt-3 font-display text-2xl font-bold text-white">{c.value}</p>
            <p className="mt-1 text-xs uppercase tracking-wide text-muted">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <RevenueChart revenue={revenue} bookings={bookings} />
      </div>
    </div>
  );
}
