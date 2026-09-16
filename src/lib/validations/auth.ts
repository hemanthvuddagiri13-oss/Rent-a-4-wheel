import { z } from "zod";

export const requestCodeSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
});

export const verifyCodeSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  code: z
    .string()
    .trim()
    .length(6, "Enter the 6-digit code.")
    .regex(/^\d{6}$/, "The code must be 6 digits."),
});

export type RequestCodeInput = z.infer<typeof requestCodeSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
