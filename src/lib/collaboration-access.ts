import type { Prisma } from "@prisma/client";
import { marketplaceActor, marketplaceHost, MarketplaceError } from "@/lib/marketplace";

export const operators = {
  MESSAGE: ["SUPPORT_AGENT", "ADMIN", "SUPER_ADMIN"],
  CLAIM: ["CLAIMS_AGENT", "SUPER_ADMIN"],
  DISPUTE: ["CLAIMS_AGENT", "SUPER_ADMIN"],
  INCIDENT: ["SUPPORT_AGENT", "CLAIMS_AGENT", "SUPER_ADMIN"],
  TICKET: ["SUPPORT_AGENT", "ADMIN", "SUPER_ADMIN"],
  REVIEW: ["ADMIN", "SUPER_ADMIN"],
} as const;
export type ServiceKind = "CLAIM" | "DISPUTE" | "INCIDENT" | "TICKET";
export function isOperator(role: string, kind: keyof typeof operators) {
  return (operators[kind] as readonly string[]).includes(role);
}
export async function participant(tx: Prisma.TransactionClient, userId: string, scope: { customerId: string; vehicleId?: string | null }, kind: keyof typeof operators) {
  const actor = await marketplaceActor(tx, userId);
  if (scope.customerId === userId) return { actor, role: "CUSTOMER" as const };
  if (isOperator(actor.role, kind)) return { actor, role: "OPERATOR" as const };
  if (scope.vehicleId && ["HOST", "HOST_EMPLOYEE"].includes(actor.role)) {
    const { host } = await marketplaceHost(tx, userId);
    const vehicle = await tx.vehicle.findUnique({ where: { id: scope.vehicleId } });
    if (vehicle?.hostId === host.id) return { actor, role: "HOST" as const };
  }
  throw new MarketplaceError("Not found.", 404);
}
export async function reservationScope(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.reservation.findUnique({ where: { id } });
  if (!r) throw new MarketplaceError("Not found.", 404);
  return r;
}
export function safeText(value: string) {
  const text = value.trim();
  if (!text || text.length > 5000 || /[<>\u0000-\u0008]|(?:javascript|data|vbscript)\s*:/i.test(text)) throw new MarketplaceError("Use plain text without HTML or unsafe links.");
  return text;
}
export async function policy(tx: Prisma.TransactionClient) {
  const row = await tx.siteSetting.findUnique({ where: { key: "collaboration.policy" } });
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const number = (key: string, fallback: number, min: number, max: number) => typeof v[key] === "number" && Number.isInteger(v[key]) ? Math.min(max, Math.max(min, v[key] as number)) : fallback;
  return { editMinutes: number("editMinutes", 10, 1, 60), reviewDays: number("reviewDays", 14, 1, 90), blindDays: number("blindDays", 14, 1, 90), responseHours: number("responseHours", 72, 1, 720), retentionDays: number("retentionDays", 1095, 30, 3650), messageDays: number("messageDays", 1095, 30, 3650), attachmentDays: number("attachmentDays", 1095, 30, 3650), reviewRetentionDays: number("reviewRetentionDays", 1095, 30, 3650), claimDays: number("claimDays", 1095, 30, 3650), disputeDays: number("disputeDays", 1095, 30, 3650), incidentDays: number("incidentDays", 1095, 30, 3650), ticketDays: number("ticketDays", 365, 30, 3650), deliveryDays: number("deliveryDays", 90, 30, 3650) };
}
export function afterDays(days: number) { return new Date(Date.now() + days * 86400000); }
export async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, entityType: string, entityId: string) {
  await tx.auditLog.create({ data: { actorId, action, entityType, entityId } });
}

export async function collaborationScopes(tx: Prisma.TransactionClient, userId: string) {
  const actor = await marketplaceActor(tx, userId);
  let vehicleIds: string[] = [];
  if (["HOST", "HOST_EMPLOYEE"].includes(actor.role)) {
    try { const { host } = await marketplaceHost(tx, userId); vehicleIds = (await tx.vehicle.findMany({ where: { hostId: host.id }, select: { id: true } })).map(v => v.id); } catch { /* Revoked memberships have no host scope. */ }
  }
  const reservationIds = (await tx.reservation.findMany({ where: { OR: [{ customerId: userId }, { vehicleId: { in: vehicleIds } }] }, select: { id: true } })).map(r => r.id);
  const conversationWhere: Prisma.ConversationWhereInput = isOperator(actor.role, "MESSAGE") ? {} : { OR: [{ customerId: userId }, { vehicleId: { in: vehicleIds } }] };
  // Opening a reservation-linked case does not grant permanent access to its tenant.
  // Resolve linked access from the current reservation, never the case's cached vehicle.
  const caseWhere: Prisma.ServiceCaseWhereInput = { OR: [
    { reservationId: null, openedById: userId },
    { reservationId: { in: reservationIds } },
    { reservationId: null, vehicleId: { in: vehicleIds } },
    { kind: { in: (["CLAIM", "DISPUTE", "INCIDENT", "TICKET"] as const).filter(kind => isOperator(actor.role, kind)) } },
  ] };
  return { conversationWhere, caseWhere };
}
