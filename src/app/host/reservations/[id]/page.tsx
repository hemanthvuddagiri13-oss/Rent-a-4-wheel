import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { marketplaceHost } from "@/lib/marketplace";
import { notFound } from "next/navigation";
import { Workspace, HostNav } from "@/components/marketplace/workspace";
import { TripConsole } from "@/components/marketplace/trip-console";
export default async function HostTripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, session = await auth(), { host } = await marketplaceHost(prisma, session!.user.id);
  const r = await prisma.reservation.findFirst({ where: { id, vehicle: { hostId: host.id } }, select: { confirmationNumber: true } });
  if (!r) notFound();
  return <Workspace eyebrow="Host trip workspace" title={r.confirmationNumber}><HostNav /><TripConsole reservationId={id} /></Workspace>;
}
