import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mobileOperations, mobileOperation } from "@/lib/mobile/contract";
import { createMobileClient, MobileApiError } from "../packages/mobile-client/src";
import { operationMetadata } from "../packages/mobile-client/src/generated";

it("every generated operation maps to the exact runtime method/path and OpenAPI operation", () => {
  const spec = JSON.parse(readFileSync("docs/api/mobile-v1.openapi.json", "utf8"));
  expect(Object.keys(operationMetadata)).toEqual(mobileOperations.map(o => o.operationId));
  for (const op of mobileOperations) {
    const request = new Request("https://fixture.invalid/api/v1/mobile" + op.path.replace(/\{[^}]+\}/g, "synthetic-id"), { method: op.method });
    expect(mobileOperation(request)?.operationId).toBe(op.operationId);
    const contract = spec.paths["/api/v1/mobile" + op.path][op.method.toLowerCase()]; expect(contract.operationId).toBe(op.operationId);
    expect(contract.security).toEqual(op.auth ? [{ nativeBearer: [] }] : []);
    if (op.idempotent) expect(contract.parameters).toContainEqual(expect.objectContaining({ in: "header", name: "Idempotency-Key", required: true }));
    expect(contract.responses["200"].headers["Cache-Control"].schema.const).toBe("private, no-store");
  }
  expect(mobileOperations.some(o => /admin|finance\/|override|payout.*POST/.test(o.path))).toBe(false);
});
it("strict response DTO rejects accidentally added provider/identity fields", () => {
  const schema = mobileOperations.find(o => o.operationId === "me")!.response;
  expect(schema.safeParse({ id: "synthetic", role: "CUSTOMER" }).success).toBe(true);
  for (const key of ["stripeCustomerId", "licenseNumber", "refreshHash", "storageKey"]) expect(schema.safeParse({ id: "synthetic", role: "CUSTOMER", [key]: "sensitive" }).success).toBe(false);
});
it("client sends bearer/idempotency explicitly, omits cookies and never automatically retries", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: null, error: { code: "CONFLICT" }, requestId: "synthetic-request" }), { status: 409, headers: { "x-api-version": "1" } }));
  const client = createMobileClient({ baseUrl: "https://fixture.invalid", accessToken: async () => "ma_synthetic", fetch: transport });
  await expect(client.call("sendMessage", { params: { id: "synthetic" }, body: { body: "Fixture" }, idempotencyKey: "synthetic-key-123456" })).rejects.toMatchObject({ status: 409, code: "CONFLICT", requestId: "synthetic-request" });
  expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", headers: { Authorization: "Bearer ma_synthetic", "Idempotency-Key": "synthetic-key-123456" } });
});
it("client rejects insecure origins, tokenless protected calls and wrong API versions", async () => {
  expect(() => createMobileClient({ baseUrl: "http://remote.invalid", accessToken: async () => null })).toThrow("HTTPS");
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "x-api-version": "2" } }));
  const client = createMobileClient({ baseUrl: "https://fixture.invalid", accessToken: async () => null, fetch: transport });
  await expect(client.call("me", {})).rejects.toBeInstanceOf(MobileApiError); expect(transport).not.toHaveBeenCalled();
  await expect(client.call("vehicles", {})).rejects.toMatchObject({ code: "API_VERSION_MISMATCH" }); expect(transport).toHaveBeenCalledTimes(1);
});
