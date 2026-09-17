import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { marketplaceHost } from "@/lib/marketplace";
import { Workspace, Panel, HostNav } from "@/components/marketplace/workspace";
import { ListingForm } from "@/components/marketplace/listing-form";
export default async function NewVehiclePage() {
  const session = await auth(), { host } = await marketplaceHost(prisma, session!.user.id, true);
  const owners = await prisma.vehicleOwner.findMany({ where: { hostId: host.id }, select: { id: true, name: true } });
  return <Workspace eyebrow="Build your fleet" title="Add a vehicle" description="First save vehicle and pricing details. Then upload photos and compliance evidence and sign the reviewed listing agreement."><HostNav /><Panel title="Vehicle, pricing and rules"><ListingForm owners={owners} /></Panel></Workspace>;
}
