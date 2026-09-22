import { z } from "zod";
import { createHoldSchema } from "@/lib/validations/reservation";
import { getSiteSettings } from "@/lib/settings";
import { bookingInstant } from "@/lib/booking-time";
import { createOrRefreshHold } from "@/lib/checkout-hold";
import { marketplaceActor, marketplaceLimit } from "@/lib/marketplace";
import { conversationAccess, openConversation, messageCommand } from "@/lib/conversations";
import { createServiceCase, createCaseSchema, caseAccess, caseCommand } from "@/lib/service-cases";
import { saveTripReview } from "@/lib/trip-reviews";
import { tripCommand } from "@/lib/trip-experience";
import { cancelCustomerReservation, startCustomerTrip } from "@/lib/customer-reservation";
import { mobileMutation } from "./mutation";
import { mobileReservationAccess } from "./queries";
import { authenticateMobile, MobileError } from "./auth";
import { mobileBody } from "./http";

export async function mobileCommand(req: Request, parts: string[]) {
  const actor = await authenticateMobile(req.headers);
  await marketplaceLimit(actor.userId);
  const input = await mobileBody(req), [resource, id, action] = parts;
  if (resource === "files" && id === "access" && parts.length === 2) {
    const { issueDocumentAccess } = await import("./files"); return issueDocumentAccess(req, input);
  }
  const active = async (tx: Parameters<typeof marketplaceActor>[0], userId: string) => { await marketplaceActor(tx, userId); };
  if (resource === "reservations" && id === "hold" && parts.length === 2) {
    const data = createHoldSchema.parse(input), timezone = (await getSiteSettings()).bookingTimezone;
    const pickupAt = bookingInstant(data.pickupAt, timezone), returnAt = bookingInstant(data.returnAt, timezone);
    return mobileMutation(req, "reservation.hold", data, active, async (tx, userId) => {
      const held = await createOrRefreshHold({ ...data, customerId: userId, bookingTimezone: timezone, pickupAt, returnAt }, tx);
      return { id: held.id };
    });
  }
  if (resource === "reservations" && id && action && parts.length === 3 && ["cancel", "start", "keys", "return", "complete"].includes(action)) {
    z.object({}).strict().parse(input);
    return mobileMutation(req, `reservation.${action}`, { id }, async (tx, userId) => { await mobileReservationAccess(tx, userId, id, ["cancel", "start"].includes(action)); }, async (tx, userId) => {
      if (action === "cancel") return cancelCustomerReservation(userId, id, tx);
      if (action === "start") return startCustomerTrip(userId, id, tx);
      return tripCommand(userId, id, action as "keys" | "return" | "complete", tx);
    });
  }
  if (resource === "conversations" && !id) {
    const data = z.object({ reservationId: z.string().max(128) }).strict().parse(input);
    return mobileMutation(req, "conversation.open", data, async (tx, userId) => { await mobileReservationAccess(tx, userId, data.reservationId); }, (tx, userId) => openConversation(userId, data, tx));
  }
  if (resource === "conversations" && id && action === "messages" && parts.length === 3) {
    const data = z.object({ body: z.string().min(1).max(5000) }).strict().parse(input);
    return mobileMutation(req, "message.send", { id, ...data }, async (tx, userId) => { await conversationAccess(tx, userId, id); }, (tx, userId) => messageCommand(userId, id, { action: "send", ...data }, tx));
  }
  if (resource === "cases" && !id) {
    const data = createCaseSchema.parse(input);
    return mobileMutation(req, "case.open", data, async (tx, userId) => {
      await active(tx, userId); if (data.reservationId) await mobileReservationAccess(tx, userId, data.reservationId);
    }, (tx, userId) => createServiceCase(userId, data, tx));
  }
  if (resource === "cases" && id && action === "reply" && parts.length === 3) {
    const data = z.object({ body: z.string().min(1).max(5000), version: z.number().int().min(0) }).strict().parse(input);
    return mobileMutation(req, "case.reply", { id, ...data }, async (tx, userId) => { await caseAccess(tx, userId, id); }, async (tx, userId) => { await caseCommand(userId, id, { ...data, action: "reply" }, tx); return { id }; });
  }
  if (resource === "reviews" && !id) {
    const data = z.object({ reservationId: z.string().max(128), subject: z.enum(["VEHICLE", "HOST", "CUSTOMER"]), rating: z.number().int().min(1).max(5), body: z.string().min(3).max(5000), cleanliness: z.number().int().min(1).max(5), communication: z.number().int().min(1).max(5), accuracy: z.number().int().min(1).max(5), version: z.number().int().min(0).optional() }).strict().parse(input);
    return mobileMutation(req, "review.save", data, async (tx, userId) => { await mobileReservationAccess(tx, userId, data.reservationId); }, (tx, userId) => saveTripReview(userId, data, tx));
  }
  throw new MobileError("NOT_FOUND", 404);
}
