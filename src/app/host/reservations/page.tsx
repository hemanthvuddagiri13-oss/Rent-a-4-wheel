import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { marketplaceHost } from "@/lib/marketplace";
import { Workspace, Panel, HostNav } from "@/components/marketplace/workspace";
export default async function HostReservationsPage() {
  const session = await auth(), { host } = await marketplaceHost(prisma, session!.user.id);
  const reservations = await prisma.reservation.findMany({ where: { vehicle: { hostId: host.id } }, select: { id: true, confirmationNumber: true, status: true, pickupAt: true, returnAt: true, vehicle: { select: { make: true, model: true } } }, orderBy: { pickupAt: "desc" }, take: 100 });
  return <Workspace eyebrow="Host workspace" title="Reservations and active rentals"><HostNav /><Panel title="Your reservations">{reservations.length ? reservations.map(r => <Link key={r.id} href={`/host/reservations/${r.id}`} className="flex flex-wrap justify-between gap-3 border-b border-white/10 py-5 text-silver hover:text-gold-bright"><span>{r.vehicle.make} {r.vehicle.model}<span className="mt-1 block text-xs">{r.confirmationNumber} · {r.pickupAt.toISOString().slice(0, 10)} → {r.returnAt.toISOString().slice(0, 10)}</span></span><span className="text-sm">{r.status.replaceAll("_", " ")}</span></Link>) : <p className="text-silver">No reservations yet.</p>}</Panel></Workspace>;
}
