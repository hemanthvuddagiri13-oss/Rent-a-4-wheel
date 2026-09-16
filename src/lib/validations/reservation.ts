import { z } from "zod";
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date.");

export const driverInfoSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required."),
  lastName: z.string().trim().min(1, "Last name is required."),
  dob: calendarDate,
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  phone: z.string().trim().min(7, "Enter a valid phone number."),
  address: z.string().trim().min(1, "Address is required."),
  city: z.string().trim().min(1, "City is required."),
  state: z.string().trim().length(2, "Use a 2-letter state code."),
  zip: z.string().trim().min(5, "Enter a valid ZIP code."),
  country: z.string().trim().default("US"),
  licenseNumber: z.string().trim().min(1, "License number is required."),
  licenseState: z.string().trim().length(2, "Use a 2-letter state code."),
  licenseExpiration: calendarDate,
});

export const createHoldSchema = z.object({
  draftId: z.string().uuid(),
  revision: z.number().int().positive().max(2147483647),
  vehicleId: z.string().min(1),
  pickupAt: z.string().min(1),
  returnAt: z.string().min(1),
  extraIds: z.array(z.string()).default([]),
  couponCode: z.string().trim().optional(),
});

export const checkoutSchema = z.object({
  bookingFingerprint: z.string().optional(),
  driver: driverInfoSchema,
  documentIds: z.object({
    front: z.string().optional(),
    back: z.string().optional(),
    selfie: z.string().optional(),
  }),
  agreementAccepted: z.literal(true, { message: "You must accept the Rental Agreement to continue." }),
});

export type CreateHoldInput = z.infer<typeof createHoldSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
