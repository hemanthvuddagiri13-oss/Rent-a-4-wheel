import { describe, it, expect } from "vitest";
import { canAccessAdmin, canManageSettings } from "@/lib/rbac";

describe("canAccessAdmin", () => {
  it("allows ADMIN and STAFF", () => {
    expect(canAccessAdmin("ADMIN")).toBe(true);
    expect(canAccessAdmin("STAFF")).toBe(true);
  });

  it("denies CUSTOMER and unauthenticated users", () => {
    expect(canAccessAdmin("CUSTOMER")).toBe(false);
    expect(canAccessAdmin(undefined)).toBe(false);
    expect(canAccessAdmin(null)).toBe(false);
    expect(canAccessAdmin("")).toBe(false);
  });

  it("denies an unrecognized or tampered role string", () => {
    expect(canAccessAdmin("SUPERADMIN")).toBe(false);
  });
});

describe("canManageSettings", () => {
  it("allows only ADMIN", () => {
    expect(canManageSettings("ADMIN")).toBe(true);
    expect(canManageSettings("STAFF")).toBe(false);
    expect(canManageSettings("CUSTOMER")).toBe(false);
  });
});
