import { z } from "zod";
import { createHoldSchema, checkoutSchema } from "@/lib/validations/reservation";

const id = z.string().min(1).max(128), date = z.iso.datetime(), cents = z.number().int(), empty = z.object({}).strict();
const success = z.object({ success: z.boolean() }).strict(), identifier = z.object({ id }).strict();
const vehicle = z.object({ id, slug: z.string(), year: z.number().int(), make: z.string(), model: z.string(), category: z.string(), transmission: z.string(), fuelType: z.string(), seats: z.number().int(), dailyRateCents: cents, securityDepositCents: cents, location: z.string(), jurisdictionCode: z.string().nullable() }).strict();
const reservation = z.object({ id, confirmationNumber: z.string(), vehicleId: id, status: z.string(), pickupAt: date, returnAt: date, bookingTimezone: z.string(), pickupLocation: z.string(), expiresAt: date.nullable(), subtotalCents: cents, extrasCents: cents, discountCents: cents, taxCents: cents, feesCents: cents, totalCents: cents, depositCents: cents, bookingFingerprint: z.string().nullable() }).strict();
const doc = z.object({ id, type: z.string(), status: z.string(), malwareScanStatus: z.string() }).strict();
const serviceCase = z.object({ id, kind: z.string(), category: z.string(), title: z.string(), state: z.string(), version: z.number().int(), reservationId: id.nullable() }).strict();
const page = (item: z.ZodType) => z.object({ items: z.array(item), nextCursor: id.nullable() }).strict();
const items = (item: z.ZodType) => z.object({ items: z.array(item) }).strict();
const credentials = z.object({ tokenType: z.literal("Bearer"), accessToken: z.string(), refreshToken: z.string(), accessExpiresAt: date, refreshExpiresAt: date, sessionId: id }).strict();
const review = z.object({ reservationId: id, subject: z.enum(["VEHICLE", "HOST", "CUSTOMER"]), rating: z.number().int().min(1).max(5), body: z.string().min(3).max(5000), cleanliness: z.number().int().min(1).max(5), communication: z.number().int().min(1).max(5), accuracy: z.number().int().min(1).max(5), version: z.number().int().min(0).optional() }).strict();
const caseInput = z.object({ kind: z.enum(["CLAIM", "DISPUTE", "INCIDENT", "TICKET"]), reservationId: id.optional(), category: z.string().min(1).max(60), title: z.string().min(3).max(160), body: z.string().min(10).max(5000), linkedCaseId: id.optional(), location: z.string().max(300).optional(), severity: z.enum(["MINOR", "MODERATE", "SEVERE"]).optional(), occurredAt: date.optional(), people: z.string().max(500).optional(), policeReport: z.string().max(100).optional(), provider: z.string().max(300).optional(), originalPhotoIds: z.array(id).max(30).optional() }).strict();
const photoCategory = z.enum(["EXTERIOR", "INTERIOR", "ODOMETER", "FUEL_GAUGE", "DAMAGE"]);
export const reportInput = z.object({ phase: z.enum(["PRE_TRIP", "POST_TRIP"]), mileage: z.number().int().min(0).max(10000000), fuelLevel: z.number().int().min(0).max(100), damageNotes: z.string().max(2000).optional(), photos: z.array(z.object({ uploadId: z.uuid(), category: photoCategory }).strict()).min(2).max(10) }).strict();
export const mobileUploadInput = z.object({ reservationId: id.optional(), type: z.enum(["LICENSE_FRONT", "LICENSE_BACK", "SELFIE_WITH_LICENSE", "INSPECTION"]), mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(1).max(8388608) }).strict();
export type MobileOperation = { operationId: string; method: "GET" | "POST"; path: string; auth: boolean; response: z.ZodType; body?: z.ZodType; idempotent?: boolean; paginated?: boolean; binary?: "request" | "response"; capability?: boolean; responseMediaTypes?: readonly string[] };
const get = (operationId: string, path: string, response: z.ZodType, options: Partial<MobileOperation> = {}): MobileOperation => ({ operationId, method: "GET", path, auth: true, response, ...options });
const post = (operationId: string, path: string, body: z.ZodType, response: z.ZodType, options: Partial<MobileOperation> = {}): MobileOperation => ({ operationId, method: "POST", path, auth: true, body, response, idempotent: true, ...options });
export const mobileOperations: MobileOperation[] = [
  post("requestPhoneCode", "/auth/request-phone-code", z.object({ phone: z.string().min(7).max(40), deviceId: z.uuid() }).strict(), z.object({ accepted: z.literal(true), challengeId: z.uuid(), retryAfterSeconds: z.number().int() }).strict(), { auth: false, idempotent: false }),
  post("phoneSignIn", "/auth/phone-sign-in", z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/), deviceId: z.uuid(), platform: z.enum(["IOS", "ANDROID"]), appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/) }).strict(), credentials, { auth: false, idempotent: false }),
  post("requestIdentityCode", "/auth/request-identity-code", z.object({ purpose: z.enum(["LINK_PHONE", "CURRENT_PHONE", "CHANGE_PHONE", "RECOVERY", "LINK_EMAIL"]), target: z.string().min(3).max(254), proofId: z.uuid().optional() }).strict(), z.object({ accepted: z.literal(true), challengeId: z.uuid(), retryAfterSeconds: z.number().int() }).strict(), { idempotent: false }),
  post("verifyIdentityCode", "/auth/verify-identity-code", z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict(), z.object({ outcome: z.enum(["LINKED", "PROVED", "REVIEW_REQUIRED"]), proofId: z.uuid().nullable(), requiresSignIn: z.boolean(), recoveryId: z.uuid().nullable() }).strict(), { idempotent: false }),
  get("loginMethods", "/auth/methods", z.object({ phoneLinked: z.boolean(), phoneLabel: z.string().nullable(), emailLinked: z.boolean(), email: z.string().nullable(), recoveryId: z.uuid().nullable() }).strict()),
  post("requestCode", "/auth/request-code", z.object({ email: z.email().max(254) }).strict(), z.object({ accepted: z.literal(true) }).strict(), { auth: false, idempotent: false }),
  post("signIn", "/auth/sign-in", z.object({ email: z.email().max(254), code: z.string().regex(/^\d{6}$/), deviceId: z.uuid(), platform: z.enum(["IOS", "ANDROID"]), appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/) }).strict(), credentials, { auth: false, idempotent: false }),
  post("refresh", "/auth/refresh", z.object({ refreshToken: z.string().max(100) }).strict(), credentials, { auth: false, idempotent: false }),
  ...["logout", "logout-all"].map((p, i) => post(i ? "logoutAll" : "logout", "/auth/" + p, empty, z.object({ revoked: z.literal(true) }).strict(), { idempotent: false })),
  post("revokeDevice", "/auth/revoke", z.object({ sessionId: id }).strict(), z.object({ revoked: z.literal(true) }).strict(), { idempotent: false }),
  get("devices", "/auth/devices", z.object({ devices: z.array(z.object({ id, platform: z.string(), appVersion: z.string(), lastUsedAt: date, expiresAt: date }).strict()) }).strict()),
  get("me", "/me", z.object({ id, role: z.enum(["CUSTOMER", "HOST", "HOST_EMPLOYEE"]) }).strict()),
  get("vehicles", "/vehicles", page(vehicle), { auth: false, paginated: true }),
  get("vehicle", "/vehicles/{id}", vehicle, { auth: false }),
  get("listingPhotos", "/vehicles/{id}/photos", items(z.object({ id, path: z.string(), alt: z.string() }).strict()), { auth: false }),
  post("availability", "/vehicles/{id}/availability", z.object({ pickupAt: date, returnAt: date }).strict(), z.object({ available: z.boolean(), authoritativeAt: date, holdRequired: z.literal(true) }).strict(), { auth: false, idempotent: false }),
  get("reservations", "/reservations", page(reservation), { paginated: true }),
  get("reservation", "/reservations/{id}", reservation),
  post("hold", "/reservations/hold", createHoldSchema, identifier),
  post("checkout", "/reservations/{id}/checkout", checkoutSchema.extend({ agreementContentHash: z.string().regex(/^[0-9a-f]{64}$/) }), identifier.extend({ success: z.literal(true) })),
  get("agreementPreview", "/reservations/{id}/agreement-preview", z.object({ type: z.literal("RENTAL_AGREEMENT"), version: z.string(), content: z.string(), contentHash: z.string(), needsAttorneyReview: z.boolean() }).strict()),
  get("pricing", "/reservations/{id}/pricing", z.object({ subtotalCents: cents, extrasCents: cents, discountCents: cents, taxCents: cents, totalCents: cents, depositCents: cents, platformFeeCents: cents.nullable(), protectionCents: cents.nullable(), processingCents: cents.nullable(), hostCommissionCents: cents.nullable().optional(), hostEarningsCents: cents.nullable().optional(), reserveCents: cents.nullable().optional(), approval: z.literal("SAMPLE_UNAPPROVED") }).strict()),
  ...["cancel", "start", "keys", "return", "complete"].map(action => post("trip" + action[0].toUpperCase() + action.slice(1), `/reservations/{id}/${action}`, empty, success)),
  get("paymentStatus", "/reservations/{id}/payment-status", z.object({ status: z.string(), depositRequired: z.boolean(), outcome: z.string(), paidCents: cents, refundedCents: cents, pendingRefundCents: cents, refundStatus: z.string(), depositValid: z.boolean(), moneyAvailable: z.boolean(), financialEligible: z.boolean(), rentalPaymentStatus: z.string().nullable(), depositStatus: z.string().nullable() }).strict()),
  get("agreements", "/reservations/{id}/agreements", items(z.object({ id, type: z.string(), documentVersion: z.string(), contentHash: z.string(), signedAt: date }).strict())),
  get("trip", "/reservations/{id}/trip", z.object({ trip: z.object({ startedAt: date.nullable(), endedAt: date.nullable(), startMileage: cents.nullable(), endMileage: cents.nullable(), startFuelLevel: cents.nullable(), endFuelLevel: cents.nullable() }).strict().nullable(), gate: z.object({ canStart: z.boolean(), reasons: z.array(z.string()) }).strict() }).strict()),
  get("reservationDocuments", "/reservations/{id}/documents", items(doc)),
  get("documents", "/documents", page(doc.extend({ reservationId: id.nullable() })), { paginated: true }),
  post("initializeUpload", "/uploads", mobileUploadInput, z.object({ id, expiresAt: date, maxBytes: z.number().int() }).strict()),
  post("finalizeUpload", "/uploads/{id}/finalize", z.string(), identifier, { binary: "request" }),
  post("documentAccess", "/files/access", z.object({ documentId: id }).strict(), z.object({ capability: z.string(), expiresInSeconds: z.literal(60), documentId: id }).strict(), { idempotent: false }),
  get("privateDocument", "/files/{id}", z.string(), { binary: "response", capability: true, responseMediaTypes: ["image/jpeg", "image/png", "image/webp"] }),
  get("reports", "/reservations/{id}/reports", items(z.object({ id, phase: z.string(), submittedByRole: z.string(), mileage: cents, fuelLevel: cents, damageNotes: z.string().nullable(), acceptedAt: date.nullable(), photos: z.array(z.object({ id, category: photoCategory }).strict()) }).strict())),
  get("reportPhoto", "/reservations/{id}/reports/{reportId}/photos/{photoId}", z.string(), { binary: "response", responseMediaTypes: ["image/jpeg", "image/png", "image/webp"] }),
  post("submitReport", "/reservations/{id}/reports", reportInput, identifier),
  post("acceptReport", "/reservations/{id}/reports/{reportId}/accept", empty, success),
  get("conversations", "/conversations", page(z.object({ id, reservationId: id.nullable(), vehicleId: id, updatedAt: date }).strict()), { paginated: true }),
  get("messages", "/conversations/{id}", page(z.object({ id, body: z.string(), createdAt: date, editedAt: date.nullable(), version: z.number().int() }).strict()), { paginated: true }),
  post("openConversation", "/conversations", z.object({ reservationId: id }).strict(), identifier),
  post("sendMessage", "/conversations/{id}/messages", z.object({ body: z.string().min(1).max(5000) }).strict(), identifier),
  get("notifications", "/notifications", page(z.object({ id, category: z.string(), title: z.string(), readAt: date.nullable(), createdAt: date, resourceType: z.string(), resourceId: id }).strict()), { paginated: true }),
  get("cases", "/cases", page(serviceCase), { paginated: true }),
  get("serviceCase", "/cases/{id}", serviceCase),
  get("caseEvents", "/cases/{id}/events", page(z.object({ id, body: z.string(), action: z.string(), createdAt: date }).strict()), { paginated: true }),
  post("openCase", "/cases", caseInput, identifier),
  post("replyCase", "/cases/{id}/reply", z.object({ body: z.string().min(1).max(5000), version: z.number().int().min(0) }).strict(), identifier),
  post("saveReview", "/reviews", review, identifier),
  get("hostFleet", "/host/fleet", page(vehicle.extend({ status: z.string(), listingApproval: z.string() })), { paginated: true }),
  get("hostReservations", "/host/reservations", page(reservation), { paginated: true }),
  get("hostEarnings", "/host/earnings", page(z.object({ id, reservationId: id, currency: z.string(), grossCents: cents, commissionCents: cents, hostDiscountCents: cents, netCents: cents, refundedCents: cents, adjustmentCents: cents, held: z.boolean(), payoutEnabled: z.literal(false) }).strict()), { paginated: true }),
];
export function mobileOperation(req: Request) {
  const path = new URL(req.url).pathname.slice("/api/v1/mobile".length);
  return mobileOperations.find(op => op.method === req.method && new RegExp("^" + op.path.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(path));
}
