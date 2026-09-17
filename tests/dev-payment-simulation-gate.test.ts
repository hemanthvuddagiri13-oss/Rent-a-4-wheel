import { afterEach, describe, expect, it, vi } from "vitest";
import { isDevPaymentSimulationAllowed } from "@/lib/stripe";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("item 16 — dev payment simulation gate", () => {
  it("is allowed only with explicit opt-in, NODE_ENV=development, and zero Stripe configuration", () => {
    vi.stubEnv("ALLOW_DEV_PAYMENT_SIMULATION", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect(isDevPaymentSimulationAllowed()).toBe(true);
  });

  it("rejects without the explicit opt-in flag even in development with no Stripe config", () => {
    vi.stubEnv("ALLOW_DEV_PAYMENT_SIMULATION", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(isDevPaymentSimulationAllowed()).toBe(false);
  });

  it("rejects in production even with the opt-in flag set", () => {
    vi.stubEnv("ALLOW_DEV_PAYMENT_SIMULATION", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevPaymentSimulationAllowed()).toBe(false);
  });

  it("rejects in a staging-like environment (any NODE_ENV other than development)", () => {
    vi.stubEnv("ALLOW_DEV_PAYMENT_SIMULATION", "true");
    vi.stubEnv("NODE_ENV", "staging");
    expect(isDevPaymentSimulationAllowed()).toBe(false);
  });

  it("rejects when only a secret key is partially configured (no publishable key yet)", () => {
    vi.stubEnv("ALLOW_DEV_PAYMENT_SIMULATION", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_live_looking_but_partial");
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "");
    expect(isDevPaymentSimulationAllowed()).toBe(false);
  });

  it("rejects when only a webhook secret is configured (nothing else)", () => {
    vi.stubEnv("ALLOW_DEV_PAYMENT_SIMULATION", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_partial");
    expect(isDevPaymentSimulationAllowed()).toBe(false);
  });
});
