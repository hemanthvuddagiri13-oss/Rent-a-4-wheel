import { z } from "zod";

export const quoteRequestSchema = z
  .object({
    pickupAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
    returnAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
    extraIds: z.array(z.string()).default([]),
    couponCode: z.string().trim().optional(),
  })
  .refine((data) => new Date(data.returnAt) > new Date(data.pickupAt), {
    message: "Return date must be after pickup date.",
    path: ["returnAt"],
  });

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
