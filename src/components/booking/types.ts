import type { PricingBreakdown } from "@/lib/pricing";

export interface BookingVehicle {
  id: string;
  slug: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  dailyRateCents: number;
  weeklyRateCents: number;
  monthlyRateCents: number;
  securityDepositCents: number;
  imageUrl: string | null;
}

export interface BookingExtra {
  id: string;
  name: string;
  description: string | null;
  chargeType: "ONE_TIME" | "DAILY" | "PERCENTAGE";
  amountCents: number | null;
  percent: number | null;
}

export interface DriverFormState {
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  licenseNumber: string;
  licenseState: string;
  licenseExpiration: string;
}

export const emptyDriverForm: DriverFormState = {
  firstName: "",
  lastName: "",
  dob: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
  licenseNumber: "",
  licenseState: "",
  licenseExpiration: "",
};

export interface BookingState {
  bookingTimezone?: string;
  draftId: string;
  revision: number;
  checkoutComplete?: boolean;
  bookingFingerprint?: string;
  pickupDate: string;
  pickupTime: string;
  returnDate: string;
  returnTime: string;
  selectedExtraIds: string[];
  couponCode: string;
  driver: DriverFormState;
  documentIds: { front?: string; back?: string; selfie?: string };
  agreementAccepted: boolean;
  breakdown: PricingBreakdown | null;
  reservationId: string | null;
  confirmationNumber: string | null;
  holdExpiresAt: string | null;
}

export type UpdateBookingState = (
  patch: Partial<BookingState> | ((prev: BookingState) => Partial<BookingState>)
) => void;

export const BOOKING_STEPS = [
  "Vehicle",
  "Dates",
  "Extras",
  "Driver",
  "Review",
  "Payment",
  "Confirmation",
] as const;
