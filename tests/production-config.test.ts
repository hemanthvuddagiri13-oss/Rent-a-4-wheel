import { describe, expect, it } from "vitest";
import { productionConfiguration } from "../src/lib/production-config";
import { localDevelopment } from "../src/lib/deployment-environment";
const configured = () => ({
  APP_ENV: "staging", NODE_ENV: "production", DATABASE_URL: "postgresql://runtime:secure@db.internal/staging?sslmode=verify-full",
  DIRECT_DATABASE_URL: "postgresql://migration:secure@db.internal/staging?sslmode=verify-full", SITE_URL: "https://staging.renta4wheel.com",
  PRIMARY_DOMAIN: "staging.renta4wheel.com", AUTH_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48),
  STRIPE_SECRET_KEY: "sk_test_fixture", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_CONNECT_COUNTRY: "US", RESEND_API_KEY: "re_fixture", EMAIL_FROM: "Staging <staging@renta4wheel.com>",
  PRIVATE_STORAGE_PROVIDER: "s3", PRIVATE_STORAGE_ENV: "staging", PRIVATE_STORAGE_BUCKET: "r4w-staging-private",
  PRIVATE_STORAGE_REGION: "us-east-1", PRIVATE_STORAGE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
  PRIVATE_STORAGE_KMS_KEY_ID: "staging-key", PRIVATE_STORAGE_ACCESS_KEY_ID: "fixture", PRIVATE_STORAGE_SECRET_ACCESS_KEY: "fixture",
  CLAMAV_HOST: "scanner.internal", CLAMAV_PORT: "3310", RATE_LIMIT_STORE: "postgres",
  MONITORING_ALERT_URL: "https://alerts.internal/ingest", MONITORING_ALERT_SECRET: "c".repeat(48), DEPLOYMENT_DATA_ENV: "staging", PROVIDER_ACCOUNT_ENV: "staging",
});
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
    for (const change of [{ STRIPE_WEBHOOK_SECRET: "" }, { STRIPE_SECRET_KEY: "sk_live_secret" }, { LIVE_FINANCE_ENABLED: "true" }, { DIRECT_DATABASE_URL: "postgresql://user:secret@pooler.internal/db?sslmode=verify-full" }, { DEPLOYMENT_DATA_ENV: "production" }, { PRIVATE_STORAGE_ENV: "production" }, { PROVIDER_ACCOUNT_ENV: "production" }, { VERCEL_ENV: "preview" }, { SITE_URL: "http://staging.renta4wheel.com" }]) expect(productionConfiguration({ ...configured(), ...change }).ready).toBe(false);
  });
});
