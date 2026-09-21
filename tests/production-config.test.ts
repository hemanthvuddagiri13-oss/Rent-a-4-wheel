import { describe, expect, it } from "vitest";
import { productionConfiguration } from "../src/lib/production-config";
import { localDevelopment } from "../src/lib/deployment-environment";
import {configured} from "./helpers/production-config-fixture";
describe("deployment trust boundary", () => {
  it("accepts complete isolated staging syntax without claiming provider health", () => expect(productionConfiguration(configured()).ready).toBe(true));
  it("reports missing production configuration without echoing secrets", () => {
    const result = productionConfiguration({ APP_ENV: "production", AUTH_SECRET: "secret-should-not-appear" });
    expect(result.ready).toBe(false); expect(JSON.stringify(result)).not.toContain("secret-should-not-appear");
    expect(result.issues).toContainEqual({ field: "DIRECT_DATABASE_URL", code: "MISSING" });
  });
  it.each(["preview", "staging", "production"])("refuses development bypass in %s even under next dev", APP_ENV => {
    const env = { ...configured(), APP_ENV, NODE_ENV: "development", ALLOW_DEV_PAYMENT_SIMULATION: "true" };
    expect(localDevelopment(env)).toBe(false); expect(productionConfiguration(env).issues).toContainEqual({ field: "DEVELOPMENT_BYPASS", code: "UNSAFE" });
  });
  it.each(["AUTH_SECRET", "CRON_SECRET", "PRIVATE_STORAGE_BUCKET", "CLAMAV_HOST", "MONITORING_ALERT_URL"])("blocks missing %s", field => {
    expect(productionConfiguration({ ...configured(), [field]: undefined }).ready).toBe(false);
  });
  it("blocks partial Stripe, live keys, live gates, poolers and cross-environment resources", () => {
    for (const change of [{ STRIPE_WEBHOOK_SECRET: "" }, { STRIPE_SECRET_KEY: "sk_live_secret" }, { LIVE_FINANCE_ENABLED: "true" }, { DIRECT_DATABASE_URL: "postgresql://user:secret@pooler.internal/db?sslmode=require&sslaccept=strict" }, { DEPLOYMENT_DATA_ENV: "production" }, { PRIVATE_STORAGE_ENV: "production" }, { PROVIDER_ACCOUNT_ENV: "production" }, { VERCEL_ENV: "preview" }, { SITE_URL: "http://staging.renta4wheel.com" }]) expect(productionConfiguration({ ...configured(), ...change }).ready).toBe(false);
  });
});
