import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Panel } from "@/components/marketplace/workspace";
import { ActionForm } from "@/components/marketplace/action-form";
export default async function MarketplaceAdminPage() {
  const [hosts, listings, documents, disputes, maintenance, audit] = await Promise.all([
    prisma.hostProfile.findMany({ where: { onboardingStatus: { in: ["SUBMITTED", "APPROVED", "SUSPENDED"] } }, orderBy: { updatedAt: "desc" }, take: 50 }),
    prisma.vehicle.findMany({ where: { listingApproval: "PENDING" }, include: { host: { select: { legalName: true } } }, take: 50 }),
    prisma.driverDocument.findMany({ where: { status: "PENDING_VERIFICATION", deletedAt: null }, select: { id: true, type: true, malwareScanStatus: true, reservationId: true }, take: 50 }),
    prisma.reservation.findMany({ where: { status: { in: ["DISPUTED", "UNDER_CLAIM_REVIEW"] } }, select: { id: true, confirmationNumber: true, status: true }, take: 50 }),
    prisma.vehicle.findMany({ where: { OR: [{ nextMaintenanceDueAt: { lte: new Date() } }, { insuranceExpiresAt: { lte: new Date() } }, { registrationExpiresAt: { lte: new Date() } }] }, select: { id: true, make: true, model: true }, take: 50 }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 80, select: { id: true, createdAt: true, action: true, entityType: true, entityId: true } }),
  ]);
  return <div className="space-y-6"><h1 className="font-display text-3xl text-white">Marketplace operations</h1><div className="flex flex-wrap gap-4 text-gold-bright"><Link href="/admin/reservations">Reservations and active trips</Link><Link href="/admin/legal">Agreement templates</Link><Link href="/admin/financial-cases">Financial reconciliation</Link></div>
    <Panel title="Host applications">{hosts.map(h => <div key={h.id} className="mb-8 border-b border-white/10 pb-6"><h3 className="mb-2 text-lg text-white">{h.businessName || h.legalName}</h3><p className="mb-4 text-sm text-silver">{h.legalName} · {h.city}, {h.state} · {h.onboardingStatus}</p><ActionForm endpoint="/api/admin/marketplace" action="host" values={{ id: h.id }} label="Record host decision" fields={[{ name: "status", label: "Decision", options: ["APPROVED", "REJECTED", "SUSPENDED"] }, { name: "reason", label: "Review reason" }]} /></div>)}{!hosts.length && <p className="text-silver">No host applications.</p>}</Panel>
    <Panel title="Vehicle approval queue">{listings.map(v => <div key={v.id} className="mb-8 border-b border-white/10 pb-6"><Link href={`/admin/marketplace/vehicles/${v.id}`} className="text-gold-bright underline">{v.year} {v.make} {v.model}</Link><p className="my-3 text-sm text-silver">Host: {v.host?.legalName || "Company"}</p><ActionForm endpoint="/api/admin/marketplace" action="vehicle" values={{ id: v.id }} label="Record listing decision" fields={[{ name: "status", label: "Decision", options: ["APPROVED", "REJECTED"] }, { name: "reason", label: "Review reason" }]} /></div>)}{!listings.length && <p className="text-silver">No pending listings.</p>}</Panel>
    <Panel title="Customer verification">{documents.map(d => <p key={d.id} className="mb-3 text-silver">{d.type} · {d.malwareScanStatus} {d.reservationId && <Link className="text-gold-bright underline" href={`/admin/reservations/${d.reservationId}`}>Review reservation</Link>}</p>)}{!documents.length && <p className="text-silver">No pending documents.</p>}</Panel>
    <Panel title="Disputes and damage review">{disputes.map(r => <p key={r.id} className="mb-3 text-silver"><Link href={`/admin/reservations/${r.id}`} className="text-gold-bright underline">{r.confirmationNumber}</Link> · {r.status}</p>)}{!disputes.length && <p className="text-silver">No open disputes.</p>}</Panel>
    <Panel title="Maintenance and compliance alerts">{maintenance.map(v => <p key={v.id} className="mb-3"><Link className="text-gold-bright underline" href={`/admin/vehicles/${v.id}`}>{v.make} {v.model}</Link></p>)}{!maintenance.length && <p className="text-silver">No overdue date-based alerts.</p>}</Panel>
    <Panel title="Recent audit history"><ol className="space-y-4 text-xs text-silver">{audit.map(a => <li key={a.id} className="break-all">{a.createdAt.toISOString()} · {a.action} · {a.entityType} {a.entityId}</li>)}</ol></Panel>
  </div>;
}
