import { z } from "zod";

export const quoteRequestSchema = z
  .object({
    pickupAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
    returnAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
    extraIds: z.array(z.string()).default([]),
    couponCode: z.string().trim().optional(),
  });

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
