import { z } from "zod";
import { createHash } from "node:crypto";
import { createHoldSchema } from "@/lib/validations/reservation";
import { checkoutSchema } from "@/lib/validations/reservation";
import { checkoutReservation } from "@/lib/checkout-service";
import { lockReservation } from "@/lib/financial-locks";
import { requireCheckoutAdmission } from "@/lib/admission-authority";
import { saveConditionReport, acceptConditionReport } from "@/lib/condition-reports";
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
import { mobileReservationAccess, mobileQuery } from "./queries";
import { isVehicleAvailable } from "@/lib/availability";
import { authenticateMobile, MobileError } from "./auth";
import { mobileBody, mobileIp } from "./http";

function mobileBookingDates(data: { pickupAt: string; returnAt: string }, timezone: string) {
  try { return { pickupAt: bookingInstant(data.pickupAt, timezone), returnAt: bookingInstant(data.returnAt, timezone) }; }
  catch { throw new MobileError("INVALID_REQUEST", 400); }
}

export async function mobileCommand(req: Request, parts: string[]) {
  if (parts[0] === "vehicles" && parts[2] === "availability" && parts.length === 3) {
    const data = z.object({ pickupAt: z.iso.datetime(), returnAt: z.iso.datetime() }).strict().parse(await mobileBody(req));
    const { pickupAt: pickup, returnAt: end } = mobileBookingDates(data, (await getSiteSettings()).bookingTimezone);
    if (pickup <= new Date() || end <= pickup || end.getTime() - pickup.getTime() > 366 * 86400000) throw new MobileError("INVALID_REQUEST", 400);
    await mobileQuery(req, ["vehicles", parts[1]]);
    return { available: await isVehicleAvailable(parts[1], pickup, end), authoritativeAt: new Date().toISOString(), holdRequired: true };
  }
  const actor = await authenticateMobile(req.headers);
  await marketplaceLimit(actor.userId);
  const [resource, id, action] = parts;
  if (resource === "uploads" && id && action === "finalize" && parts.length === 3) {
    const { finalizeMobileUpload } = await import("./uploads"); return finalizeMobileUpload(req, id);
  }
  const input = await mobileBody(req);
  if (resource === "uploads" && !id) {
    const { initializeMobileUpload } = await import("./uploads"); return initializeMobileUpload(req, input);
  }
  if (resource === "files" && id === "access" && parts.length === 2) {
    const { issueDocumentAccess } = await import("./files"); return issueDocumentAccess(req, input);
  }
  const active = async (tx: Parameters<typeof marketplaceActor>[0], userId: string) => { await marketplaceActor(tx, userId); };
  if (resource === "reservations" && id && action === "reports" && parts.length === 3) {
    const data = z.object({ phase: z.enum(["PRE_TRIP", "POST_TRIP"]), mileage: z.number().int().min(0).max(10000000), fuelLevel: z.number().int().min(0).max(100), damageNotes: z.string().max(2000).optional(), photos: z.array(z.object({ uploadId: z.uuid(), category: z.enum(["EXTERIOR", "INTERIOR", "ODOMETER", "FUEL_GAUGE", "DAMAGE"]) }).strict()).min(2).max(10) }).strict().parse(input);
    if (!data.photos.some(p => p.category === "EXTERIOR") || !data.photos.some(p => p.category === "INTERIOR") || new Set(data.photos.map(p => p.uploadId)).size !== data.photos.length) throw new MobileError("INVALID_REQUEST", 400);
    return mobileMutation(req, "report.submit", { id, ...data }, async (tx, userId) => { await mobileReservationAccess(tx, userId, id); }, async (tx, userId) => {
      const photos = [];
      for (const p of data.photos) {
        const upload = await tx.mobileUpload.findFirst({ where: { id: p.uploadId, userId, reservationId: id, type: "INSPECTION", finalizedAt: { not: null } } });
        if (!upload?.storageKey) throw new MobileError("NOT_FOUND", 404);
        const object = await tx.privateObject.findUnique({ where: { key: upload.storageKey } });
        if (!object || object.deletedAt || object.state !== "CLEAN" || object.writeState !== "STORED") throw new MobileError("CONFLICT", 409);
        photos.push({ category: p.category, storageKey: upload.storageKey });
      }
      return saveConditionReport(userId, id, { ...data, photos }, tx);
    });
  }
  if (resource === "reservations" && id && action === "reports" && parts.length === 5 && parts[4] === "accept") {
    z.object({}).strict().parse(input); const reportId = parts[3];
    return mobileMutation(req, "report.accept", { id, reportId }, async (tx, userId) => { await mobileReservationAccess(tx, userId, id); }, async (tx, userId) => { await acceptConditionReport(userId, id, reportId, tx); return { success: true }; });
  }
  if (resource === "reservations" && id && action === "checkout" && parts.length === 3) {
    const data = checkoutSchema.parse(input);
    const { agreementContentHash } = z.object({ agreementContentHash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(input);
    return mobileMutation(req, "reservation.checkout", { id, ...data, agreementContentHash }, async (tx, userId) => {
      await mobileReservationAccess(tx, userId, id, true);
      const current = await lockReservation(tx, id);
      if (current.financialDisposition !== "OPEN" || !["CHECKOUT_HOLD", "AWAITING_PAYMENT"].includes(current.status) || !current.expiresAt || current.expiresAt <= new Date()) throw new MobileError("CONFLICT", 409);
      await requireCheckoutAdmission(tx, id);
      const signed = current.checkoutFingerprint ? await tx.agreementAcceptance.findFirst({ where: { reservationId: id, type: "RENTAL_AGREEMENT" }, orderBy: { signedAt: "desc" }, select: { contentHash: true } }) : null;
      if (signed) { if (signed.contentHash !== agreementContentHash) throw new MobileError("CONFLICT", 409); }
      else {
        await tx.$queryRaw`SELECT "id" FROM "LegalDocument" WHERE "type"='RENTAL_AGREEMENT' FOR UPDATE`;
        const legal = await tx.legalDocument.findUnique({ where: { type: "RENTAL_AGREEMENT" } });
        if (!legal || createHash("sha256").update(legal.content).digest("hex") !== agreementContentHash) throw new MobileError("CONFLICT", 409);
      }
    }, async (tx, userId) => {
      const response = await checkoutReservation(new Request(req.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Rent A 4Wheel native API v1", "x-real-ip": mobileIp(req.headers) }, body: JSON.stringify(data) }), id, userId, tx);
      if (!response.ok) throw new MobileError(response.status === 403 ? "FORBIDDEN" : "CONFLICT", response.status);
      return { id, success: true };
    });
  }
  if (resource === "reservations" && id === "hold" && parts.length === 2) {
    const data = createHoldSchema.parse(input), timezone = (await getSiteSettings()).bookingTimezone;
    const { pickupAt, returnAt } = mobileBookingDates(data, timezone);
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
