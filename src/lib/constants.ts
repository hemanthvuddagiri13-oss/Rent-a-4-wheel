export const SITE_NAME = "Rent A 4Wheel";
export const SITE_TAGLINE = "DRIVE MORE POSSIBILITIES";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://renta4wheel.com";

export const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/vehicles", label: "Vehicles" },
  { href: "/how-it-works", label: "How It Works" },
  { href: "/long-term-rentals", label: "Long-Term Rentals" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
] as const;

export const VEHICLE_CATEGORY_LABELS: Record<string, string> = {
  ALL: "All",
  ECONOMY: "Economy",
  SEDAN: "Sedan",
  SUV: "SUV",
  LUXURY: "Luxury",
  TRUCK: "Truck",
};

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
