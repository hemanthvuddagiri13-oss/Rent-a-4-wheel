import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { marketplaceHost } from "@/lib/marketplace";
import { Workspace, Panel, HostNav } from "@/components/marketplace/workspace";
import { formatCurrency } from "@/lib/utils";
export default async function FleetPage() {
  const session = await auth(), { host, role } = await marketplaceHost(prisma, session!.user.id);
  const vehicles = await prisma.vehicle.findMany({ where: { hostId: host.id }, orderBy: { createdAt: "desc" } });
  return <Workspace eyebrow="Host workspace" title="Your fleet" description="Manage listing details, compliance, pricing and calendar availability."><HostNav />{role !== "STAFF" && <Link className="inline-block rounded-lg bg-gold px-5 py-3 font-semibold text-black" href="/host/vehicles/new">Add a vehicle</Link>}<div className="grid gap-5 md:grid-cols-2">{vehicles.map(v => <Panel key={v.id} title={`${v.year} ${v.make} ${v.model}`}><p className="text-silver">{v.listingApproval} · {v.status} · {formatCurrency(v.dailyRateCents)}/day</p><Link href={`/host/vehicles/${v.id}`} className="mt-5 inline-block text-gold-bright underline">Manage vehicle</Link></Panel>)}</div>{!vehicles.length && <Panel title="Your first listing starts here"><p className="text-silver">Add your vehicle details, photos and compliance documents. We will review the listing before it becomes bookable.</p></Panel>}</Workspace>;
}
