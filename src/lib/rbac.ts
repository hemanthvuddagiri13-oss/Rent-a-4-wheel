export type AppRole = "CUSTOMER" | "STAFF" | "ADMIN" | "SUPER_ADMIN" | "HOST" | "HOST_EMPLOYEE";

const ADMIN_AREA_ROLES: AppRole[] = ["ADMIN", "SUPER_ADMIN", "STAFF"];
const SETTINGS_ROLES: AppRole[] = ["ADMIN", "SUPER_ADMIN"];
const EMERGENCY_OVERRIDE_ROLES: AppRole[] = ["SUPER_ADMIN"];

export function canAccessAdmin(role: string | undefined | null): boolean {
  return ADMIN_AREA_ROLES.includes(role as AppRole);
}

export function canManageSettings(role: string | undefined | null): boolean {
  return SETTINGS_ROLES.includes(role as AppRole);
}

// Deliberately narrower than canAccessAdmin/canManageSettings: forcing a
// reservation past an unmet gate is not an ordinary admin action, so an
// ordinary ADMIN (let alone STAFF) role is not sufficient — only the
// dedicated SUPER_ADMIN role may even attempt it, and every attempt still
// requires a fresh step-up verification on top of this role check (see
// src/lib/emergency-override.ts).
export function canPerformEmergencyOverride(role: string | undefined | null): boolean {
  return EMERGENCY_OVERRIDE_ROLES.includes(role as AppRole);
}
