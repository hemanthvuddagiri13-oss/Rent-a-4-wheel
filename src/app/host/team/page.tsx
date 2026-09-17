import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { marketplaceHost } from "@/lib/marketplace";
import { ActionForm } from "@/components/marketplace/action-form";
import { Workspace, Panel, HostNav } from "@/components/marketplace/workspace";
export default async function TeamPage() {
  const session = await auth();
  const { host, role } = await marketplaceHost(prisma, session!.user.id);
  const [employees, owners] = await Promise.all([prisma.hostEmployee.findMany({ where: { hostId: host.id }, include: { user: { select: { email: true } } } }), prisma.vehicleOwner.findMany({ where: { hostId: host.id } })]);
  return <Workspace eyebrow="Host workspace" title="People behind your fleet" description="Owners and managers manage fleet operations. Only the business owner can grant or remove employee access. Staff handle assigned pickups and returns."><HostNav />
    <Panel title="Team access">{employees.length ? employees.map(e => <div key={e.id} className="mb-5 flex flex-wrap items-center justify-between gap-3"><p className="break-all text-silver">{e.user.email} · {e.role}</p>{role === "OWNER" && <ActionForm action="removeEmployee" values={{ id: e.id }} label="Remove access" />}</div>) : <p className="mb-5 text-silver">No employees have access.</p>}{role === "OWNER" && <ActionForm action="employee" label="Grant employee access" fields={[{ name: "email", label: "Existing account email", type: "email" }, { name: "role", label: "Permission", options: ["STAFF", "MANAGER"] }]} />}</Panel>
    <Panel title="Vehicle owners">{owners.map(o => <p key={o.id} className="mb-3 text-silver">{o.name} · {o.email}</p>)}{!owners.length && <p className="mb-5 text-silver">No vehicle owners added.</p>}{role !== "STAFF" && <ActionForm action="owner" label="Add vehicle owner" fields={[{ name: "name", label: "Owner name" }, { name: "email", label: "Owner email", type: "email" }, { name: "phone", label: "Owner phone", type: "tel" }]} />}</Panel>
  </Workspace>;
}
