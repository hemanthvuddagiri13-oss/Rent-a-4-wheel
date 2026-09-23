import { randomUUID } from "node:crypto";
import { deploymentEnvironment, localDevelopment } from "@/lib/deployment-environment";

/** Only this boundary talks to SMS infrastructure. No automatic delivery/check retry. */
export interface SmsVerificationProvider {
  start(phone: string): Promise<string>;
  check(sid: string, code: string): Promise<boolean>;
}
export function smsProvider(): SmsVerificationProvider {
  const mode = process.env.MOBILE_SMS_PROVIDER;
  if (mode === "fixture" && localDevelopment() && /^\d{6}$/.test(process.env.MOBILE_SMS_FIXTURE_CODE ?? "")) {
    return {
      async start(phone) {
        // Reserved fictional NANP range only. Credentials never trigger a real send.
        if (!/^\+120255501\d{2}$/.test(phone)) throw new Error("SMS_FIXTURE_NUMBER_REQUIRED");
        return "fixture:" + randomUUID();
      },
      async check(sid, code) { return sid.startsWith("fixture:") && code === process.env.MOBILE_SMS_FIXTURE_CODE; },
    };
  }
  const account = process.env.TWILIO_ACCOUNT_SID, secret = process.env.TWILIO_AUTH_TOKEN, service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (mode !== "twilio" || !["staging", "production"].includes(deploymentEnvironment()) || process.env.MOBILE_SMS_SEND_ENABLED !== "true" || !/^AC[0-9a-f]{32}$/i.test(account ?? "") || !secret || !/^VA[0-9a-f]{32}$/i.test(service ?? "")) throw new Error("SMS_NOT_CONFIGURED");
  async function request(path: string, body: URLSearchParams) {
    const response = await fetch(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
      method: "POST", headers: { Authorization: "Basic " + Buffer.from(account + ":" + secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body, signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store",
    });
    if (!response.ok) throw new Error("SMS_PROVIDER_UNAVAILABLE");
    return await response.json() as { sid?: string; status?: string; to?: string; service_sid?: string };
  }
  return {
    async start(phone) {
      const result = await request("Verifications", new URLSearchParams({ To: phone, Channel: "sms" }));
      if (!/^VE[0-9a-f]{32}$/i.test(result.sid ?? "") || result.status !== "pending" || result.to !== phone || result.service_sid !== service) throw new Error("SMS_PROVIDER_INVALID_RESPONSE");
      return result.sid!;
    },
    async check(sid, code) {
      if (!/^VE[0-9a-f]{32}$/i.test(sid)) throw new Error("SMS_PROVIDER_INVALID_ID");
      const result = await request("VerificationCheck", new URLSearchParams({ VerificationSid: sid, Code: code }));
      return result.sid === sid && result.service_sid === service && result.status === "approved";
    },
  };
}
