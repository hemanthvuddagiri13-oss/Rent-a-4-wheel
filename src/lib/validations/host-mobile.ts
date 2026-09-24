import { z } from "zod";
export const handoffSchema = z.object({ licenseMatchesUpload: z.boolean(), physicalLicenseUnexpired: z.boolean(), selfieMatchesCustomer: z.boolean(), notes: z.string().max(2000).optional() }).strict();
export const hostAvailabilityInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("block"), startAt: z.iso.datetime(), endAt: z.iso.datetime(), reason: z.enum(["MAINTENANCE", "OWNER_REQUEST", "OTHER"]), notes: z.string().max(2000) }).strict(),
  z.object({ action: z.literal("unblock"), id: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal("availability"), isBookable: z.boolean() }).strict(),
]);
export const calendarInput = z.object({ startAt: z.iso.datetime(), endAt: z.iso.datetime() }).strict();
