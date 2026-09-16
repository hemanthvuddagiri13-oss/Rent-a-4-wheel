import { z } from "zod";

export const driverInfoSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required."),
  lastName: z.string().trim().min(1, "Last name is required."),
  dob: z.string().min(1, "Date of birth is required."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  phone: z.string().trim().min(7, "Enter a valid phone number."),
  address: z.string().trim().min(1, "Address is required."),
  city: z.string().trim().min(1, "City is required."),
  state: z.string().trim().length(2, "Use a 2-letter state code."),
  zip: z.string().trim().min(5, "Enter a valid ZIP code."),
  country: z.string().trim().default("US"),
  licenseNumber: z.string().trim().min(1, "License number is required."),
  licenseState: z.string().trim().length(2, "Use a 2-letter state code."),
  licenseExpiration: z.string().min(1, "License expiration is required."),
});

export const createHoldSchema = z.object({
  vehicleId: z.string().min(1),
  pickupAt: z.string().min(1),
  returnAt: z.string().min(1),
  extraIds: z.array(z.string()).default([]),
  couponCode: z.string().trim().optional(),
});

export const checkoutSchema = z.object({
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
