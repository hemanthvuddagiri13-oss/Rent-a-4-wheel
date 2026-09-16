import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { prisma, createTestVehicle, createTestCustomer, cleanupReservationsForVehicles } from "./helpers/factories";

const mocks = vi.hoisted(() => ({ session: null as { user: { id: string } } | null, create: vi.fn(), retrieve: vi.fn(), email: vi.fn() }));
vi.mock("@/auth", () => ({ auth: async () => mocks.session }));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.email }));
vi.mock("@/lib/stripe", async () => {
  const { default: SDK } = await import("stripe");
  return { stripe: { webhooks: new SDK("sk_test_offline").webhooks, paymentIntents: { create: mocks.create, retrieve: mocks.retrieve }, refunds: { list: () => [] } },
    isStripeConfigured: () => true, isDevPaymentSimulationAllowed: () => false, ensureStripeCustomer: async () => "cus_http" };
});
vi.mock("@/lib/agreements", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/agreements")>(), generateAndStoreSignedAgreementPdf: vi.fn().mockResolvedValue(undefined) }));
const hold = await import("@/app/api/reservations/hold/route");
const checkout = await import("@/app/api/reservations/[id]/checkout/route");
const payment = await import("@/app/api/reservations/[id]/payment-intent/route");
const status = await import("@/app/api/reservations/[id]/status/route");
const webhook = await import("@/app/api/webhooks/stripe/route");
const cron = await import("@/app/api/cron/financial/[worker]/route");
let server: Server, base: string;
const vehicles: string[] = [], users: string[] = [], events: string[] = [];
const webhookSecret = "whsec_http_test";
beforeAll(async () => {
  vi.stubEnv("CRON_SECRET", "http-cron-test"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", webhookSecret);
  server = createServer(async (incoming, outgoing) => {
    try {
      let body = ""; for await (const chunk of incoming) body += String(chunk);
      const req = new NextRequest(`${base}${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string,string>, body: ["GET","HEAD"].includes(incoming.method ?? "GET") ? undefined : body });
      const segments = incoming.url!.split("/").filter(Boolean);
      let response: Response;
      if (segments[0] === "hold") response = await hold.POST(req);
      else if (segments[0] === "webhook") response = await webhook.POST(req);
      else if (segments[0] === "cron") response = await cron.POST(req, { params: Promise.resolve({ worker: segments[1] }) });
      else {
        const context = { params: Promise.resolve({ id: segments[1] }) };
        response = segments[2] === "checkout" ? await checkout.POST(req, context) : segments[2] === "payment" ? await payment.POST(req, context) : await status.GET(req, context);
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch (e) { outgoing.writeHead(500); outgoing.end(String(e)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { in: events } } });
  await cleanupReservationsForVehicles(vehicles);
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  vi.unstubAllEnvs(); await prisma.$disconnect();
});
const post = (path: string, body: unknown, headers: Record<string,string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("financial routes over HTTP with the real database", () => {
  it("protects every cron worker and rejects an unsigned webhook", async () => {
    for (const worker of ["stripe-events","refunds","deposits","reconciliation","outbox"]) expect((await post(`/cron/${worker}`, {})).status).toBe(401);
    expect((await post("/webhook", {})).status).toBe(400);
    vi.stubEnv("CRON_SECRET", ""); expect((await post("/cron/outbox", {})).status).toBe(503); vi.stubEnv("CRON_SECRET", "http-cron-test");
    mocks.session = null; expect((await post("/hold", {})).status).toBe(401);
  });

  it("idempotently checks out, persists rental intent, recovers a stale event, and reports confirmed only after processing", async () => {
    const v = await createTestVehicle({ securityDepositCents: 0 }), u = await createTestCustomer(); vehicles.push(v.id); users.push(u.id); mocks.session = { user: { id: u.id } };
    const holdResponse = await post("/hold", { vehicleId: v.id, pickupAt: "2031-04-01T10:00:00Z", returnAt: "2031-04-03T10:00:00Z", extraIds: [] });
    expect(holdResponse.status).toBe(200); const held = await holdResponse.json();
    const docs = await Promise.all((["LICENSE_FRONT","LICENSE_BACK","SELFIE_WITH_LICENSE"] as const).map(type => prisma.driverDocument.create({ data: { reservationId: held.id, userId: u.id, type, storageKey: `local:http-${type}`, mimeType: "image/jpeg", contentSha256: "test", fileSizeBytes: 10 } })));
    const oldLegal = await prisma.legalDocument.findUnique({ where: { type: "RENTAL_AGREEMENT" } });
    await prisma.legalDocument.upsert({ where: { type: "RENTAL_AGREEMENT" }, update: { needsAttorneyReview: false }, create: { type: "RENTAL_AGREEMENT", title: "Test terms", content: "Test agreement", needsAttorneyReview: false } });
    const body = { bookingFingerprint: held.bookingFingerprint, agreementAccepted: true, documentIds: { front: docs[0].id, back: docs[1].id, selfie: docs[2].id }, driver: { firstName: "Test", lastName: "Customer", dob: "1990-01-01", email: u.email, phone: "5551234567", address: "1 Test St", city: "Dallas", state: "TX", zip: "75001", country: "US", licenseNumber: "TEST123", licenseState: "TX", licenseExpiration: "2035-01-01" } };
    try {
      const responses = await Promise.all([post(`/r/${held.id}/checkout`, body), post(`/r/${held.id}/checkout`, body)]);
      for (const response of responses) expect(response.status, await response.text()).toBe(200);
      expect(await prisma.agreementAcceptance.count({ where: { reservationId: held.id } })).toBe(1);
      expect((await post(`/r/${held.id}/checkout`, { ...body, driver: { ...body.driver, phone: "5559999999" } })).status).toBe(409);
    } finally {
      if (oldLegal) await prisma.legalDocument.update({ where: { id: oldLegal.id }, data: { needsAttorneyReview: oldLegal.needsAttorneyReview } });
      else await prisma.legalDocument.delete({ where: { type: "RENTAL_AGREEMENT" } });
    }
    const intent = { id: `pi_http_${held.id}`, client_secret: "pi_http_secret", status: "requires_payment_method", metadata: { reservationId: held.id } };
    mocks.create.mockResolvedValue(intent); mocks.retrieve.mockResolvedValue(intent);
    expect((await post(`/r/${held.id}/payment`, {})).status).toBe(200);
    expect((await post(`/r/${held.id}/payment`, {})).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect((await (await fetch(`${base}/r/${held.id}/status`)).json()).outcome).toBe("processing");
    const event = { id: `evt_http_${held.id}`, type: "payment_intent.succeeded", data: { object: { ...intent, status: "succeeded" } } }; events.push(event.id);
    await prisma.stripeEvent.create({ data: { stripeEventId: event.id, type: event.type, payload: event, status: "PROCESSING", leaseToken: "dead-worker", processingStartedAt: new Date(0) } });
    const recovered = await post("/cron/stripe-events", {}, { authorization: "Bearer http-cron-test" });
    expect(recovered.status).toBe(200);
    expect((await (await fetch(`${base}/r/${held.id}/status`)).json()).outcome).toBe("confirmed");
    const payload = JSON.stringify(event);
    const signature = new Stripe("sk_test_offline").webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    expect((await post("/webhook", event, { "stripe-signature": signature })).status).toBe(200);
    const paymentRow = await prisma.payment.findFirstOrThrow({ where: { reservationId: held.id } });
    await prisma.refund.create({ data: { reservationId: held.id, paymentId: paymentRow.id, amountCents: paymentRow.amountCents, idempotencyKey: `http-refund:${held.id}`, status: "PENDING" } });
    expect((await (await fetch(`${base}/r/${held.id}/status`)).json()).outcome).toBe("refund_pending");
  });
});
