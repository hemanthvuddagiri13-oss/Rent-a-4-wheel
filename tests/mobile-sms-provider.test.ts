import { afterEach, expect, it, vi } from "vitest";
import { smsProvider } from "@/lib/mobile/sms-provider";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("SMS is disabled without explicit configuration and never sends from development", () => {
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  vi.stubEnv("MOBILE_SMS_PROVIDER", ""); expect(() => smsProvider()).toThrow("SMS_NOT_CONFIGURED");
  vi.stubEnv("MOBILE_SMS_PROVIDER", "twilio"); vi.stubEnv("MOBILE_SMS_SEND_ENABLED", "true");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC" + "a".repeat(32)); vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA" + "b".repeat(32)); vi.stubEnv("TWILIO_AUTH_TOKEN", "synthetic-provider-secret");
  for (const env of ["development", "test", "preview"]) { vi.stubEnv("APP_ENV", env); expect(() => smsProvider()).toThrow("SMS_NOT_CONFIGURED"); }
  expect(transport).not.toHaveBeenCalled();
});
it("explicit SMS fixtures only accept reserved numbers and never work in staging or production", async () => {
  vi.stubEnv("APP_ENV", "test"); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("MOBILE_SMS_PROVIDER", "fixture"); vi.stubEnv("MOBILE_SMS_FIXTURE_CODE", "123456");
  const transport = vi.fn(); vi.stubGlobal("fetch", transport); const provider = smsProvider();
  const sid = await provider.start("+12025550101"); expect(await provider.check(sid, "123456")).toBe(true);
  expect(await provider.check(sid, "999999")).toBe(false); await expect(provider.start("+12125551212")).rejects.toThrow("SMS_FIXTURE_NUMBER_REQUIRED");
  for (const env of ["staging", "production"]) { vi.stubEnv("APP_ENV", env); expect(() => smsProvider()).toThrow("SMS_NOT_CONFIGURED"); }
  expect(transport).not.toHaveBeenCalled();
});
it("Twilio adapter binds approval to the exact service and verification SID without retrying uncertainty", async () => {
  vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("MOBILE_SMS_PROVIDER", "twilio"); vi.stubEnv("MOBILE_SMS_SEND_ENABLED", "true");
  const service = "VA" + "b".repeat(32), sid = "VE" + "c".repeat(32);
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC" + "a".repeat(32)); vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", service); vi.stubEnv("TWILIO_AUTH_TOKEN", "synthetic-provider-secret");
  const transport = vi.fn().mockResolvedValueOnce(Response.json({ sid, service_sid: service, to: "+12025550101", status: "pending" }))
    .mockResolvedValueOnce(Response.json({ sid, service_sid: service, status: "approved" }))
    .mockResolvedValueOnce(Response.json({ sid: "VE" + "d".repeat(32), service_sid: service, status: "approved" }))
    .mockRejectedValueOnce(new TypeError("network lost"));
  vi.stubGlobal("fetch", transport); const provider = smsProvider();
  expect(await provider.start("+12025550101")).toBe(sid); expect(await provider.check(sid, "123456")).toBe(true);
  expect(await provider.check(sid, "123456")).toBe(false); await expect(provider.check(sid, "123456")).rejects.toThrow("network lost");
  expect(transport).toHaveBeenCalledTimes(4);
  expect(String(transport.mock.calls[1][1].body)).toBe("VerificationSid=" + sid + "&Code=123456");
  expect(transport.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
});
