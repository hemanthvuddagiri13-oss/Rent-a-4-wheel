import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getHostContext } from "@/lib/host-access";
import { Workspace, Panel, HostNav } from "@/components/marketplace/workspace";
export default async function HostPage() {
  const session = await auth();
  const context = session?.user ? await getHostContext(session.user.id) : null;
  if (!context) return <Workspace eyebrow="Your business, on the road" title="Become a Rent A 4Wheel host" description="Build your fleet, prepare every pickup and keep your rental operations in one place."><Panel title="Start with your business"><p className="mb-6 text-silver">Submit your business profile for review. Listings stay unavailable until the required documents, agreements and approvals are complete.</p><Link className="inline-block rounded-lg bg-gold px-5 py-3 font-semibold text-black" href="/host/profile">Start host application</Link></Panel></Workspace>;
  const [host, vehicles, active, upcoming] = await Promise.all([
    prisma.hostProfile.findUniqueOrThrow({ where: { id: context.hostId } }),
    prisma.vehicle.count({ where: { hostId: context.hostId } }),
    prisma.reservation.count({ where: { vehicle: { hostId: context.hostId }, status: { in: ["ACTIVE", "RETURN_IN_PROGRESS"] } } }),
    prisma.reservation.findMany({ where: { vehicle: { hostId: context.hostId }, status: { in: ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"] } }, include: { vehicle: true }, orderBy: { pickupAt: "asc" }, take: 8 }),
  ]);
  return <Workspace eyebrow="Host workspace" title={host.businessName || host.legalName} description={`Application: ${host.onboardingStatus.replaceAll("_", " ")}. Your access: ${context.role.toLowerCase()}.`}><HostNav /><div className="grid gap-4 sm:grid-cols-3">{[["Vehicles", vehicles], ["Active rentals", active], ["Upcoming pickups", upcoming.length]].map(([name, value]) => <Panel key={name} title={String(name)}><p className="text-4xl text-gold-bright">{value}</p></Panel>)}</div><Panel title="Prepare for pickup">{upcoming.length ? <div className="divide-y divide-white/10">{upcoming.map(r => <Link className="flex flex-wrap justify-between gap-3 py-4 text-silver hover:text-gold-bright" href={`/host/reservations/${r.id}`} key={r.id}><span>{r.vehicle.make} {r.vehicle.model} · {r.confirmationNumber}</span><span>{r.pickupAt.toLocaleDateString("en-US", { timeZone: r.bookingTimezone })}</span></Link>)}</div> : <p className="text-silver">No upcoming pickups. Approved, available listings can accept reservations.</p>}</Panel></Workspace>;
}
