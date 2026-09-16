export type AppRole = "CUSTOMER" | "STAFF" | "ADMIN";

const ADMIN_AREA_ROLES: AppRole[] = ["ADMIN", "STAFF"];
const SETTINGS_ROLES: AppRole[] = ["ADMIN"];

export function canAccessAdmin(role: string | undefined | null): boolean {
  return ADMIN_AREA_ROLES.includes(role as AppRole);
}

export function canManageSettings(role: string | undefined | null): boolean {
  return SETTINGS_ROLES.includes(role as AppRole);
}
