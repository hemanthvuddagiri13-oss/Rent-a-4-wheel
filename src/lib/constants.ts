export const SITE_NAME = "Rent A 4Wheel";
export const SITE_TAGLINE = "DRIVE MORE POSSIBILITIES";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://renta4wheel.com";

export const NAV_LINKS = [
  { href: "/account", label: "My trips" },
  { href: "/vehicles", label: "Vehicles" },
  { href: "/how-it-works", label: "How It Works" },
  { href: "/host", label: "Host workspace" },
  { href: "/faq", label: "FAQ" },
  { href: "/connect", label: "Inbox & help" },
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
  DRAFT: "Draft",
  CHECKOUT_HOLD: "Checkout Hold",
  AWAITING_PAYMENT: "Awaiting Payment",
  CONFIRMED: "Confirmed",
  DOCUMENTS_REQUIRED: "Documents Required",
  READY_FOR_CHECK_IN: "Ready for Check-In",
  CHECK_IN_PROGRESS: "Check-In in Progress",
  READY_TO_START: "Ready to Start",
  ACTIVE: "Active",
  RETURN_IN_PROGRESS: "Return in Progress",
  COMPLETED: "Completed",
  CANCELLED_BY_CUSTOMER: "Cancelled by Customer",
  CANCELLED_BY_HOST: "Cancelled by Host",
  PAYMENT_FAILED: "Payment Failed",
  EXPIRED: "Expired",
  DISPUTED: "Disputed",
  UNDER_CLAIM_REVIEW: "Under Claim Review",
};
