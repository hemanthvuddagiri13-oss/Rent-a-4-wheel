import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { isTransientStripeError } from "@/lib/deposit-authorization";

describe("item 4/6 — transient Stripe error classification", () => {
  it("classifies a rate-limit error as transient, never as a card decline", () => {
    const err = new Stripe.errors.StripeRateLimitError({ message: "Too many requests" });
    expect(isTransientStripeError(err)).toBe(true);
  });

  it("classifies a network/connection error as transient", () => {
    const err = new Stripe.errors.StripeConnectionError({ message: "ECONNRESET" });
    expect(isTransientStripeError(err)).toBe(true);
  });

  it("classifies a Stripe-side API error as transient", () => {
    const err = new Stripe.errors.StripeAPIError({ message: "Stripe had an internal error" });
    expect(isTransientStripeError(err)).toBe(true);
  });

  it("does NOT classify a genuine card error (decline) as transient", () => {
    const err = new Stripe.errors.StripeCardError({ message: "Your card was declined." });
    expect(isTransientStripeError(err)).toBe(false);
  });

  it("does not classify a plain non-Stripe error as transient", () => {
    expect(isTransientStripeError(new Error("some unrelated failure"))).toBe(false);
  });
});
