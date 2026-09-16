import { prisma } from "@/lib/prisma";

export interface HostContext {
  hostId: string;
  role: "OWNER" | "MANAGER" | "STAFF";
}

/**
 * Resolves the host a user is acting for, whether they *are* the host
 * account (Role.HOST) or an employee granted access to it
 * (Role.HOST_EMPLOYEE via HostEmployee). Returns null if the user has no
 * host affiliation at all — every host-scoped endpoint must treat that as
 * "no access to any vehicle or booking," never fall back to "admin-like."
 */
export async function getHostContext(userId: string): Promise<HostContext | null> {
  const hostProfile = await prisma.hostProfile.findUnique({ where: { userId }, select: { id: true } });
  if (hostProfile) return { hostId: hostProfile.id, role: "OWNER" };

  const employment = await prisma.hostEmployee.findFirst({
    where: { userId },
    select: { hostId: true, role: true },
  });
  if (employment) return { hostId: employment.hostId, role: employment.role };

  return null;
}

/**
 * The core cross-tenant guard: a host (owner or employee) may only ever
 * touch vehicles/bookings that belong to *their own* HostProfile. There is
 * no code path that lets a host context reach another host's data.
 */
export async function hostOwnsVehicle(context: HostContext, vehicleId: string): Promise<boolean> {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { hostId: true } });
  return Boolean(vehicle && vehicle.hostId === context.hostId);
}

export async function hostOwnsReservation(context: HostContext, reservationId: string): Promise<boolean> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { vehicle: { select: { hostId: true } } },
  });
  return Boolean(reservation && reservation.vehicle.hostId === context.hostId);
}
