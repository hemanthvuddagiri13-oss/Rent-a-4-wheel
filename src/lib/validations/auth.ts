import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Please enter your full name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
  phone: z.string().trim().min(7, "Enter a valid phone number.").optional().or(z.literal("")),
});

export type RegisterInput = z.infer<typeof registerSchema>;
