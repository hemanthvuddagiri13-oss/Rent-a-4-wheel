import { prisma } from "@/lib/prisma";

export interface SiteSettings {
  bookingTimezone: string;
  businessName: string;
  phone: string;
  email: string;
  address: string;
  operatingHours: string;
  taxRatePercent: number;
  defaultDepositCents: number;
  minimumAge: number;
  mileagePolicySummary: string;
  cancellationPolicySummary: string;
  socialLinks: { instagram?: string; facebook?: string; tiktok?: string };
  // How many hours before pickup the customer/host check-in workflow (and
  // the trip-start gate's "pickup time is within the permitted window"
  // check) opens up. Admin-configurable per README "Customer Check-In".
  checkInWindowHours: number;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  bookingTimezone: "America/Chicago",
  businessName: "Rent A 4Wheel",
  phone: "",
  email: "",
  address: "",
  operatingHours: "",
  taxRatePercent: 8.25,
  defaultDepositCents: 35000,
  minimumAge: 21,
  mileagePolicySummary: "Daily mileage allowance varies by vehicle; see vehicle details.",
  cancellationPolicySummary: "PLACEHOLDER — pending attorney review.",
  socialLinks: {},
  checkInWindowHours: 24,
};

/**
 * Reads admin-configurable settings from the database, falling back to
 * sane defaults for any key that hasn't been set yet. This lets the
 * business owner change pricing/policy copy from /admin/settings without
 * a code change or deploy.
 */
export async function getSiteSettings(): Promise<SiteSettings> {
  try {
    const rows = await prisma.siteSetting.findMany();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { ...DEFAULT_SITE_SETTINGS, ...map } as SiteSettings;
  } catch {
    // DB unavailable (e.g. static analysis/build without a live database) —
    // fall back to defaults so pages can still render.
    return DEFAULT_SITE_SETTINGS;
  }
}
