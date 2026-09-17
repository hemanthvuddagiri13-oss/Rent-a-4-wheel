import { describe, it, expect } from "vitest";
import { canCustomerCancel } from "@/lib/reservation-rules";

const now = new Date("2026-06-01T00:00:00Z");

describe("canCustomerCancel", () => {
  it("allows cancelling an AWAITING_PAYMENT reservation before pickup", () => {
    const result = canCustomerCancel({ status: "AWAITING_PAYMENT", pickupAt: new Date("2026-07-01") }, now);
    expect(result.allowed).toBe(true);
  });

  it("allows cancelling a CONFIRMED reservation before pickup", () => {
    const result = canCustomerCancel({ status: "CONFIRMED", pickupAt: new Date("2026-07-01") }, now);
    expect(result.allowed).toBe(true);
  });

  it("denies cancelling an ACTIVE reservation", () => {
    const result = canCustomerCancel({ status: "ACTIVE", pickupAt: new Date("2026-05-01") }, now);
    expect(result.allowed).toBe(false);
  });

  it("denies cancelling a COMPLETED reservation", () => {
    const result = canCustomerCancel({ status: "COMPLETED", pickupAt: new Date("2026-05-01") }, now);
    expect(result.allowed).toBe(false);
  });

  it("denies cancelling an already-cancelled reservation", () => {
    const result = canCustomerCancel({ status: "CANCELLED_BY_CUSTOMER", pickupAt: new Date("2026-07-01") }, now);
    expect(result.allowed).toBe(false);
  });

  it("denies self-cancellation once pickup time has arrived, even if still CONFIRMED", () => {
    const result = canCustomerCancel({ status: "CONFIRMED", pickupAt: new Date("2026-05-31T23:00:00Z") }, now);
    expect(result.allowed).toBe(false);
  });
});
